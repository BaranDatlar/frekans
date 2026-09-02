// Firebase proje ayarları — `firebase apps:sdkconfig web` çıktısından.
// Bu değerler gizli değildir (istemci tarafında zaten görünür); güvenlik
// database.rules.json ile sağlanır.
export const firebaseConfig = {
  apiKey: "AIzaSyCA2gXQTUgnHOwW7UiBNW5P-y0bk8lpwjc",
  // ÖNEMLİ: uygulama BU alan adında çalışmak zorunda. Farklı origin'de
  // Safari ve üçüncü taraf depolamayı kısan tarayıcılar giriş sonucunu
  // uygulamaya geri veremiyor (kullanıcı Google ekranlarını geçiyor ama
  // giriş ekranına dönüyor). app.js gerekirse buraya yönlendiriyor.
  //
  // Neden .web.app değil: Google'ın otomatik oluşturduğu OAuth istemcisi
  // yalnızca "<proje>.firebaseapp.com/__/auth/handler" adresini tanıyor,
  // .web.app ile redirect_uri_mismatch veriyor. Kısa adresi kullanmak
  // istersen Cloud Console > Credentials'ta o adresi de yetkilendir ve
  // burayı değiştir; app.js kendiliğinden ona yönlendirir.
  authDomain: "frekans-f3067.firebaseapp.com",
  databaseURL: "https://frekans-f3067-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "frekans-f3067",
  appId: "1:636071440002:web:c79ca4647414d843604e9b",
};
