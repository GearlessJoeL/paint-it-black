const DB_NAME = 'resume-tailor-fs';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const DIR_KEY = 'outputDir';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function idbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export function isFolderPickerSupported() {
  return typeof window.showDirectoryPicker === 'function';
}

export async function pickOutputFolder() {
  if (!isFolderPickerSupported()) {
    throw new Error('Folder picker is not supported in this browser context.');
  }
  const handle = await window.showDirectoryPicker({
    id: 'resume-tailor-output',
    mode: 'readwrite',
  });
  await idbSet(DIR_KEY, handle);
  const permission = await handle.queryPermission({ mode: 'readwrite' });
  return { name: handle.name, handle, permission };
}

export async function getSavedFolder() {
  try {
    const handle = await idbGet(DIR_KEY);
    if (!handle) return null;
    const permission = await handle.queryPermission({ mode: 'readwrite' });
    return { name: handle.name, handle, permission };
  } catch {
    return null;
  }
}

export async function requestFolderPermission(handle) {
  if (!handle) return 'denied';
  const current = await handle.queryPermission({ mode: 'readwrite' });
  if (current === 'granted') return 'granted';
  return handle.requestPermission({ mode: 'readwrite' });
}

export async function clearSavedFolder() {
  await idbDelete(DIR_KEY);
}

/**
 * Write PDF bytes into the user's selected folder.
 * Requires permission === 'granted' (call requestFolderPermission during a user gesture if needed).
 */
export async function writePdfToFolder(handle, filename, arrayBuffer) {
  if (!handle) {
    throw new Error('No output folder selected.');
  }
  const permission = await handle.queryPermission({ mode: 'readwrite' });
  if (permission !== 'granted') {
    const err = new Error('Folder permission needs to be re-confirmed.');
    err.code = 'PERMISSION_REQUIRED';
    throw err;
  }

  const fileHandle = await handle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(arrayBuffer);
  } finally {
    await writable.close();
  }
  return { folderName: handle.name, filename };
}
