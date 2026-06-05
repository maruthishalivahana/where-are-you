import admin from 'firebase-admin';
import { ENV } from './env.config';

const serviceAccount = {
  projectId: ENV.FIREBASE_PROJECT_ID,
  clientEmail: ENV.FIREBASE_CLIENT_EMAIL,
  privateKey: ENV.FIREBASE_PRIVATE_KEY,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
});

export const messaging = admin.messaging();
export default admin;
