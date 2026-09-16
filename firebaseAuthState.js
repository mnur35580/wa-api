const { BufferJSON, initAuthCreds } = require('@whiskeysockets/baileys');

/**
 * Custom Adapter untuk menyimpan Auth State Baileys ke Firebase Firestore
 * Mendukung Multi-Device dengan memisahkan collection berdasarkan Device ID
 */
const useFirebaseAuthState = async (db, deviceId) => {
    // Setiap device punya collection sendiri (misal: wa_auth_dev_1)
    const collectionName = `wa_auth_${deviceId}`;
    const coll = db.collection(collectionName);

    const writeData = async (data, id) => {
        try {
            const str = JSON.stringify(data, BufferJSON.replacer);
            await coll.doc(id).set({ data: str });
        } catch (error) {
            console.error(`[${deviceId}] Error writing to Firebase:`, error);
        }
    };

    const readData = async (id) => {
        try {
            const doc = await coll.doc(id).get();
            if (doc.exists) {
                return JSON.parse(doc.data().data, BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            console.error(`[${deviceId}] Error reading from Firebase:`, error);
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await coll.doc(id).delete();
        } catch (error) {
            console.error(`[${deviceId}] Error deleting from Firebase:`, error);
        }
    };

    // Bersihkan seluruh sesi (digunakan jika device di-logout atau dihapus dari sistem)
    const clearState = async () => {
        try {
            const snapshot = await coll.get();
            const batch = db.batch();
            snapshot.docs.forEach((doc) => {
                batch.delete(doc.ref);
            });
            await batch.commit();
        } catch (error) {
             console.error(`[${deviceId}] Error clearing state:`, error);
        }
    }

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(value, key));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => {
            return writeData(creds, 'creds');
        },
        clearState
    };
};

module.exports = useFirebaseAuthState;
