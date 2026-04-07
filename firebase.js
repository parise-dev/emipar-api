const admin = require('firebase-admin');
require('dotenv').config();

const serviceAccount = {
  project_id: process.env.FIREBASE_PROJECT_ID,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')  // Corrige as quebras de linha
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://checkout-2cde5.firebaseio.com'
});

const db = admin.firestore();

module.exports = db;
