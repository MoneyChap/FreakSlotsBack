import { db } from "./firebase.js";

export async function deleteCollection(collectionName, batchSize = 300) {
    const firestore = db();
    const colRef = firestore.collection(collectionName);

    while (true) {
        const snap = await colRef.limit(batchSize).get();
        if (snap.empty) break;

        const batch = firestore.batch();
        for (const doc of snap.docs) batch.delete(doc.ref);
        await batch.commit();
    }
}
