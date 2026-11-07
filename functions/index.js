
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

exports.deleteUserAccount = onCall(
  { region: "europe-west1" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    }

    const adminUid = request.auth.uid;
    const targetUid = String(request.data?.uid || "").trim();

    if (!targetUid || targetUid.length > 128) {
      throw new HttpsError("invalid-argument", "UID no válido.");
    }

    if (targetUid === adminUid) {
      throw new HttpsError(
        "failed-precondition",
        "No puedes eliminar tu propia cuenta."
      );
    }

    // Comprobar que el usuario que ejecuta la función es administrador.
    const adminDoc = await db.collection("admins").doc(adminUid).get();

    if (!adminDoc.exists) {
      throw new HttpsError(
        "permission-denied",
        "No eres administrador."
      );
    }

    // Proteger las demás cuentas de administrador.
    const targetAdmin = await db.collection("admins").doc(targetUid).get();

    if (targetAdmin.exists) {
      throw new HttpsError(
        "failed-precondition",
        "No se pueden eliminar cuentas de administrador."
      );
    }

    // Eliminar de Firebase Authentication.
    try {
      await getAuth().deleteUser(targetUid);
    } catch (error) {
      if (error.code !== "auth/user-not-found") {
        console.error(error);
        throw new HttpsError(
          "internal",
          "No se pudo eliminar el usuario de Authentication."
        );
      }
    }

    // Eliminar el perfil y sus subcolecciones.
    await db.recursiveDelete(
      db.collection("players").doc(targetUid)
    );

    // Eliminar documentos cuyo ID sea el UID.
    const directCollections = [
      "bans",
      "online",
      "mgfc_managers"
    ];

    for (const name of directCollections) {
      await db.collection(name).doc(targetUid).delete().catch((error) => {
        console.warn(`Error limpiando ${name}/${targetUid}:`, error);
      });
    }

    // Limpiar documentos que tengan uid o userId.
    const uidCollections = [
      "scores",
      "ratings",
      "comments",
      "livechat",
      "friends"
    ];

    for (const name of uidCollections) {
      await deleteMatching(name, "uid", targetUid);
      await deleteMatching(name, "userId", targetUid);
    }

    // Eliminar notificaciones dirigidas al usuario.
    await deleteMatching("notifications", "to", targetUid);

    // Limpiar inscripciones y puntuaciones de torneos.
    await deleteCollectionGroup("players", "uid", targetUid);
    await deleteCollectionGroup("scores", "uid", targetUid);

    return {
      success: true,
      uid: targetUid
    };
  }
);

async function deleteMatching(collectionName, field, value) {
  const snap = await db.collection(collectionName)
    .where(field, "==", value)
    .get();

  await deleteDocs(snap.docs);
}

async function deleteCollectionGroup(collectionName, field, value) {
  const snap = await db.collectionGroup(collectionName)
    .where(field, "==", value)
    .get();

  await deleteDocs(snap.docs);
}

async function deleteDocs(docs) {
  for (let i = 0; i < docs.length; i += 450) {
    const batch = db.batch();

    docs.slice(i, i + 450).forEach((doc) => {
      batch.delete(doc.ref);
    });

    await batch.commit();
  }
}
