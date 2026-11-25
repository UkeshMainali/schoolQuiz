// Firebase initialisation. Every other module imports Firebase from here so
// the SDK version is defined in exactly one place.
//
// The API key below is NOT a secret. Firebase web keys only identify the
// project; the data is protected by Firebase Authentication + Firestore
// Security Rules (see firestore.rules).

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, connectAuthEmulator, signInAnonymously, signInWithEmailAndPassword,
  signOut, onAuthStateChanged, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore, connectFirestoreEmulator,
  doc, getDoc, getDocFromServer, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where,
  orderBy, limit, startAfter, writeBatch, serverTimestamp, Timestamp, documentId,
  getCountFromServer, runTransaction
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBNtmsFGgq2vdoHjYJmkDgJh0aN_a_TcNM",
  authDomain: "quiz-f4828.firebaseapp.com",
  projectId: "quiz-f4828",
  storageBucket: "quiz-f4828.firebasestorage.app",
  messagingSenderId: "83497826359",
  appId: "1:83497826359:web:e920718ba72edd663fa7b2",
  measurementId: "G-K0P89HKTLX"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Local testing only: open any page with ?emulator=1 on localhost to use the
// Firebase Emulator Suite instead of the live project. Ignored elsewhere.
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
if (isLocal && new URLSearchParams(location.search).has("emulator")) {
  sessionStorage.setItem("useEmulator", "1");
}
if (isLocal && sessionStorage.getItem("useEmulator") === "1") {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

export {
  signInAnonymously, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  sendPasswordResetEmail,
  doc, getDoc, getDocFromServer, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where,
  orderBy, limit, startAfter, writeBatch, serverTimestamp, Timestamp, documentId,
  getCountFromServer, runTransaction
};
