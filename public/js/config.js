// Firebase proje ayarları — `firebase apps:sdkconfig web` çıktısından.
// Bu değerler gizli değildir (istemci tarafında zaten görünür); güvenlik
// database.rules.json ile sağlanır.
export const firebaseConfig = {
  apiKey: "AIzaSyCA2gXQTUgnHOwW7UiBNW5P-y0bk8lpwjc",
  // ÖNEMLİ: uygulamanın servis edildiği alan adıyla AYNI olmalı.
  // Varsayılan "<proje>.firebaseapp.com" farklı bir origin olduğu için
  // Safari ve üçüncü taraf depolamayı kısan tarayıcılar giriş sonucunu
  // uygulamaya geri veremiyor; kullanıcı Google ekranlarını geçtiği hâlde
  // giriş ekranına dönüyordu. Firebase Hosting /__/auth/* yardımcılarını
  // bu alan adında da servis ediyor.
  authDomain: "frekans-f3067.web.app",
  databaseURL: "https://frekans-f3067-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "frekans-f3067",
  appId: "1:636071440002:web:c79ca4647414d843604e9b",
};
