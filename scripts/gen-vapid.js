// Prints a fresh pair of keys for push notifications. Paste them into your Railway variables.
import webpush from 'web-push';
const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}`);
