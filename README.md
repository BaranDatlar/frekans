# Frekans

**Yayında: <https://frekans-f3067.web.app>**

[Wavelength](https://en.wikipedia.org/wiki/Wavelength_(game)) oyununun arkadaş
grubu için web klonu. Herkes kendi telefonundan girer, spektrum kartlarını
kendiniz yazarsınız.

- **Kooperatif:** takım yok, herkes aynı tarafta. Sırayla biri psişik olur.
- **Kendi spektrumlarınız:** "Soğuk ↔ Sıcak" gibi kartları uygulama içinden
  ekleyip silersiniz; havuz ortaktır, oyunda rastgele gelir.
- **Kurulum yok:** bir bağlantı gönderirsiniz, tarayıcıdan oynanır.

---

## Nasıl oynanır

Her tur:

1. Sıradaki oyuncu **psişik** olur. Ekranında bir spektrum kartı ve kadran
   üzerinde **sadece onun gördüğü** bir hedef bölgesi belirir.
2. Psişik, hedefin nerede olduğunu anlatan **tek bir ipucu** yazar
   ("ılık çorba"). Sonra susar — yüzde, sayı, yön söylemek yasak.
3. Diğerleri sesli tartışıp **ibreyi** çevirir. İbre herkeste ortaktır.
4. Biri **Kilitle** der, hedef açılır.

**Puan** — hedef merkezine yakınlığa göre:

```
       ┌──2──┬──3──┬──4──┬──3──┬──2──┐
   ────┴─────┴─────┴─────┴─────┴─────┴────
    0                  ↑ hedef                          100
```

Merkez band 4, yanları 3, en dışı 2, dışarısı 0 puan. Turlar bitince toplam
puana göre bir değerlendirme çıkar. Tur sayısı lobide ayarlanır (3–20).

---

## Kurulum

Node 18+ gerekir. Kod tarayıcıda derlenmeden çalışır; npm paketleri yalnızca
testler ve emülatör içindir.

```bash
npm install
```

### 1. Firebase projesi

Bu depo **`frekans-f3067`** projesine bağlı ve yayında; aşağıdakiler ancak
sıfırdan yeni bir kurulum yapacaksan gerekir.

1. <https://console.firebase.google.com> → **Proje ekle** (Google Cloud kullanım
   şartlarını ilk kez burada kabul edersin). Analytics'e gerek yok.
2. **Build → Authentication → Başla → Sign-in method → Anonymous** → etkinleştir.
   *(Bu adım komut satırından yapılamıyor.)*
3. Realtime Database'i oluştur. Konsoldaki sihirbaz takılırsa yönetim API'sinden
   de oluşturulabilir:

   ```bash
   TOK=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.config/configstore/firebase-tools.json')))['tokens']['access_token'])")
   curl -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
     -d '{"type":"DEFAULT_DATABASE"}' \
     "https://firebasedatabase.googleapis.com/v1beta/projects/<PROJE-ID>/locations/europe-west1/instances?databaseId=<PROJE-ID>-default-rtdb"
   ```

### 2. Projeyi bağla

```bash
npx firebase-tools login
npx firebase-tools use --add                # .firebaserc'yi günceller
npx firebase-tools apps:create web Frekans
npx firebase-tools apps:sdkconfig web       # çıkan değerleri kopyala
```

Çıktıdaki `apiKey`, `authDomain`, `databaseURL`, `projectId` ve `appId`
değerlerini `public/js/config.js` içine yaz.

> Bu değerler gizli değildir, istemcide zaten görünür. Güvenlik
> `database.rules.json` ile sağlanır.

### 3. Yayınla

```bash
npm run deploy      # kuralları + siteyi yükler
npm run smoke       # canlı adreste gerçekten bir tur oynayıp doğrular
```

Arkadaşlarına adresi gönder. Lobideki **Bağlantıyı kopyala** düğmesi oda kodunu
içeren bir link verir (`?oda=ABCD`), tek dokunuşla lobiye düşerler.

İlk açılışta **Spektrumlar** ekranından **Başlangıç setini yükle**'ye basılır —
86 hazır Türkçe spektrum eklenir. *(Bu adım bu projede yapıldı.)*

---

## Geliştirme

Yerelde çalıştırmak için Firebase emülatörü kullanılır; gerçek veritabanına
dokunulmaz. `localhost` üzerinden açıldığında uygulama otomatik olarak
emülatöre bağlanır.

```bash
npm run emu     # http://127.0.0.1:5055  (emülatör arayüzü: 4000)
npm test        # ayrı bir terminalde
```

Emülatör Java gerektirir (`java -version` ile kontrol et).

### Testler

| Dosya | Kapsam |
|---|---|
| `test/scoring.test.mjs` | Puanlama matematiği, bant sınırları, hedef üretimi |
| `test/logic.test.mjs` | Sıra devri, oyuncu ekleme, kart seçimi |
| `test/rules.test.mjs` | **Güvenlik kuralları** — hedefi kimin okuyabildiği |
| `test/e2e.test.mjs` | Üç worker, gerçek `room.js`/`game.js`, tam oyun |
| `test/ui.test.mjs` | Üç Chrome bağlamı; kadran, senkron, ekranlar |

`scripts/live-smoke.mjs` (`npm run smoke`) bunlardan ayrıdır: **canlı yayında**
gerçekten bir tur oynar, dolayısıyla üretim veritabanına yazar. Deploy sonrası
doğrulama içindir.

İlk ikisi emülatörsüz çalışır (`npm run test:unit`); diğerleri emülatör
kapalıysa atlanır.

> Testler seri çalışır (`--test-concurrency=1`), çünkü hepsi aynı emülatör
> veritabanını kullanır.

---

## Nasıl çalışıyor

Sunucu kodu yok — ne Cloud Functions ne de kendi backend'imiz. Bunun yerine:

**Hedefin gizliliği güvenlik kuralıyla sağlanır.** Hedef
`rooms/{kod}/secret/target` altında durur ve kural gereği yalnızca o turun
psişiği okuyabilir. Kilitleme anında faz `reveal` olur, kural açılır ve
**her cihaz puanı kendi başına, aynı saf fonksiyonla** hesaplar. Böylece
hakem rolüne, "host" cihazına gerek kalmaz; psişiğin bağlantısı kopsa bile
tur tamamlanır.

**Skor hiçbir yerde toplanmaz.** Her tur sonucu `history/{tur}` altına
idempotent yazılır, toplam istemcide türetilir — "puan iki kez eklendi"
hatası yapısal olarak imkânsızdır.

**Her faz geçişi tek bir transaction'dır** (`rooms/{kod}/state` üzerinde).
İki kişi aynı anda "Kilitle"ye bassa ikincisi iptal olur.

**İbre** sürüklenirken 150 ms'de bir yazılır, diğer cihazlarda yumuşatılarak
gösterilir. Kendi parmağın kadrandayken uzaktan gelen değer yok sayılır —
yoksa ibre elinin altından geri zıplar.

### Veri modeli

```
spectrums/{id}          { left, right, addedBy, createdAt }   ortak havuz

rooms/{KOD}/
  meta/createdAt
  players/{uid}         { name, online, joinedAt }
  state                 { phase, roundIndex, totalRounds, order,
                          psychicUid, spectrum, clue, dial, final }
  secret/target         korumalı düğüm
  history/{tur}         { clue, left, right, target, dial, points, psychicUid }
  usedSpectrumIds/{id}
```

### Dosyalar

```
public/js/
  scoring.js     saf matematik: hedef, bantlar, puan       (test edilir)
  logic.js       saf akış: sıra devri, kart seçimi         (test edilir)
  firebase.js    SDK kurulumu, anonim giriş, emülatör anahtarı
  room.js        oda kur/katıl, presence, abonelikler
  game.js        faz geçişleri, gizli hedef, ibre, sonuç
  dial.js        SVG kadran + sürükleme
  ui.js          ekran yönlendirme, lobi/sonuç/editör çizimi
  main.js        kablolama ve oyun sahnesi
  app.js         ince başlatıcı (ayar eksikse anlaşılır hata)
```

Tarayıcı Firebase SDK'sını CDN'den alır (`index.html` içindeki import map);
aynı dosyalar Node testlerinde `node_modules`'tan çözülür, yani testler
tarayıcıdakiyle birebir aynı kodu çalıştırır.

---

## Bilinen sınırlar

- Oyun başladıktan sonra katılanlar o turda izleyici olur; sıraya bir sonraki
  turda eklenirler.
- Boş odalar veritabanında kalır (birkaç KB). 24 saatten eski bir oda kodu
  yeniden kullanılırken otomatik temizlenir.
- Sesli iletişim uygulamada yok — oyun zaten konuşarak oynanıyor.
- **Adresi bilen herkes oynayabilir.** Kayıt yok, anonim giriş var; spektrum
  havuzu ortaktır ve giren herkes ekleyip silebilir, 4 harfli oda kodunu bilen
  odaya katılabilir. Arkadaş grubu için kasıtlı bir tercih — halka açık bir
  yerde paylaşacaksan uygun değil.
