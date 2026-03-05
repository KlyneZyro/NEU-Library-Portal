import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBEbgfhozmn-GYaDgWnd-8WP1IOAaezWrU",
  authDomain: "neu-library-a8ad9.firebaseapp.com",
  projectId: "neu-library-a8ad9",
  storageBucket: "neu-library-a8ad9.firebasestorage.app",
  messagingSenderId: "486942341175",
  appId: "1:486942341175:web:37c054f6280ec1de81e7b2",
  measurementId: "G-BRBGB7LJBS"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const provider = new GoogleAuthProvider();