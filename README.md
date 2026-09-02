# Frekans

**Yayında: <https://frekans-f3067.web.app>**

[Wavelength](https://en.wikipedia.org/wiki/Wavelength_(game)) oyununun arkadaş
grubu için web klonu. Herkes kendi telefonundan girer, spektrum kartlarını
kendiniz yazarsınız.

- **İki mod:** herkesin kendi puanını topladığı **bireysel**, ya da puanların
  takımlara yazıldığı **takım** modu.
- **Kendi kart setleriniz:** "Soğuk ↔ Sıcak" gibi kartlardan kendi setinizi
  oluşturup lobide desteye yüklersiniz. 86 hazır kart uygulamayla gelir.
- **Google ile giriş** ya da misafir olarak katılma.
- **Kurulum yok:** bir bağlantı gönderirsiniz, tarayıcıdan oynanır.

---

## Nasıl oynanır

Her tur:

1. Sıradaki oyuncu **psişik** olur. Ekranında bir spektrum kartı ve kadran
   üzerinde **sadece onun gördüğü** bir hedef bölgesi belirir.
2. Psişik, hedefin nerede olduğunu anlatan **tek bir ipucu** yazar
   ("ılık çorba"). Sonra susar — yüzde, sayı, yön söylemek yasak.
3. **Herkes kendi kadranını** çevirir. Tahminciler birbirinin ibresini
   göremez; psişik hepsini canlı görür.
4. **Herkes** kilitleyince hedef açılır. İlk kilitten sonra 20 saniyelik geri
   sayım başlar; süre biterse tur kendiliğinden açılır, kimse beklemede kalmaz.

**Puan** — hedef merkezine yakınlığa göre:

```
       ┌──2──┬──3──┬──4──┬──3──┬──2──┐
   ────┴─────┴─────┴─────┴─────┴─────┴────
    0                  ↑ hedef                          100
```

Merkez band 4, yanları 3, en dışı 2, dışarısı 0 puan. Tur sayısı lobide
ayarlanır (3–20).

### Modlar

Lobide odayı kuran kişi seçer.

**Bireysel** — herkes kendi puanını toplar. Psişik, tüm tahmincilerin puan
ortalamasını alır. Sonunda kişi başı sıralama çıkar.

**Takım** — iki takım (Mavi / Turuncu). Oynanış birebir aynı, tek fark
puanların takıma yazılması:

- Tahmincinin puanı → kendi takımına
- Psişiğin puanı = **kendi takımdaşlarının** ortalaması → takımına.
  Rakibin iyi bilmesi psişiğe yaramaz, yarışma mantığı böyle korunur.

Herkes lobide kendi takımını seçer; kurucu "Rastgele dağıt" ile eşit
bölebilir. Her takımda en az 2 kişi gerekir. Psişik sırası iki takım arasında
**dönüşümlü** ilerler, yoksa kalabalık takım daha çok sıra alıp avantaj kazanır.

### Kart setleri

86 hazır kart uygulamayla gelir (`public/js/builtin.js`) — veritabanında
değildir, kimse silemez.

Google ile giren herkes **Setlerim**'den kendi setlerini oluşturur; setler
hesaba kaydedilir, cihaz değişince kaybolmaz. Lobide **yalnızca odayı kuran**
kişi desteyi seçer:

| Seçenek | Ne çıkar |
|---|---|
| Hazır set | Uygulamayla gelen 86 kart |
| Kendi setim | Yalnızca seçilen setteki kartlar |
| Karışık | Hazır kartlar + seçilen set |

Seçilen deste odaya yazılır, herkes aynı desteden oynar.

### Giriş ve odalar

**Google ile giriş** oda kurmayı ve set kaydetmeyi açar. **Misafir** olarak
girenler odalara katılıp oynayabilir ama oda kuramaz, set kaydedemez — bu
kısıt yalnızca arayüzde değil, güvenlik kurallarında da uygulanır.

Misafirken Google'a geçersen **aynı kimlik korunur**: oyunun ortasında
odandan düşmezsin.

Odayı kuran çıkınca oda kapanır ve silinir. Her oda ayrıca **24 saat**
sonra sona erer: süresi dolmuş odaya girilemez ve uygulamayı açan ilk kişi
onu veritabanından siler.

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
2. **Build → Authentication → Sign-in method** → şu ikisini etkinleştir:
   - **Google** (destek e-postası seçilir) — oda kurmak ve set kaydetmek için
   - **Anonymous** — "Misafir olarak gir" için

   *(İkisi de komut satırından açılamıyor; Google için OAuth istemcisi
   gerektiği için API de reddediyor.)*
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
| `test/logic.test.mjs` | Sıra devri, kilitleme, bireysel puanlama |
| `test/teams.test.mjs` | Takım dağıtımı, dönüşümlü sıra, takım toplamları |
| `test/deck.test.mjs` | Deste çözümü, set doğrulama, oda ömrü |
| `test/rules.test.mjs` | **Güvenlik kuralları** — hedef, ibreler, setler, oda ömrü |
| `test/e2e.test.mjs` | Ayrı worker'lar, gerçek modüller, iki mod, misafir, deste |
| `test/ui.test.mjs` | Ayrı Chrome bağlamları; giriş, setler, takımlar, kadran |

`scripts/live-smoke.mjs` (`npm run smoke`) bunlardan ayrıdır: **canlı yayında**
gerçekten bir tur oynar, dolayısıyla üretim veritabanına yazar. Deploy sonrası
doğrulama içindir.

İlk dördü emülatörsüz çalışır; diğerleri emülatör kapalıysa atlanır.
Google girişi testlerde Auth emülatörünün imzasız kimlik belirteci desteğiyle
yapılır — gerçek Google popup'ı otomatikleştirilmez.

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
Turu kim açarsa açsın ikinci deneme iptal olur.

**Onaylar ibre değerine bağlıdır.** Kilit `true` değil, basıldığı andaki ibre
değeri olarak saklanır. Ortak modda ibre oynayınca eski onaylar kendiliğinden
geçersizleşir — kimsenin başkasının verisini silmesi gerekmez, dolayısıyla
temizleme yarışı da yoktur.

**İbre** sürüklenirken 150 ms'de bir yazılır, diğer cihazlarda yumuşatılarak
gösterilir. Kendi parmağın kadrandayken uzaktan gelen değer yok sayılır —
yoksa ibre elinin altından geri zıplar.

### Veri modeli

```
public/js/builtin.js            86 hazır kart (uygulamayla gelir)

/users/{uid}/
  profile: { name, updatedAt }
  packs/{setId}: { name, updatedAt, cards: [{l, r}] }    yalnızca sahibi

/roomIndex/{KOD}: expiresAt     süresi dolmuşları bulmak için

/rooms/{KOD}/
  meta:  { createdAt, expiresAt, hostUid }               yazma: hesap gerekir
  deck:  { source, name?, cards? }                       yazma: kurucu, lobide
  state: { phase, mode, teams, roundIndex, totalRounds, order,
           psychicUid, drawId, spectrum, clue, lockDeadline }
  players/{uid}         { name, online, joinedAt }
  secret/target         korumalı: yalnızca psişik, açılışta herkes
  guesses/{tur}/{uid}   korumalı: sahibi + psişik, açılışta herkes
  locks/{tur}/{uid}     kilitlenen ibre değeri (herkese açık)
  history/{tur}         { clue, left, right, target, psychicUid, mode,
                          guesses, points, psychicPoints, teams }
  usedSpectrumIds/{id}
```

`history` her turun **takım dağılımını** de saklar: biri sonradan takım
değiştirse bile geçmiş turların puanı kaymaz ve her cihaz aynı toplamı bulur.

### Dosyalar

```
public/js/
  scoring.js     saf matematik: hedef, bantlar, puan        (test edilir)
  logic.js       saf akış: sıra devri, kilit, bireysel puan (test edilir)
  teams.js       saf takım mantığı: dağıtım, sıra, toplam   (test edilir)
  deck.js        saf deste/set mantığı ve doğrulama         (test edilir)
  builtin.js     86 hazır kart
  firebase.js    SDK kurulumu, emülatör anahtarı
  auth.js        giriş kapısı: Google, misafir, misafir yükseltme
  packs.js       kişisel setler (hesap senkronu + cihaz önbelleği)
  room.js        oda kur/katıl, presence, ömür, süpürücü
  game.js        mod, takımlar, faz geçişleri, gizli hedef, sonuç
  dial.js        SVG kadran + sürükleme + çoklu ibre
  ui.js          ekran yönlendirme, lobi/sonuç/set çizimi
  main.js        kablolama ve oyun sahnesi
  app.js         ince başlatıcı (ayar eksikse anlaşılır hata)
```

Tarayıcı Firebase SDK'sını CDN'den alır (`index.html` içindeki import map);
aynı dosyalar Node testlerinde `node_modules`'tan çözülür, yani testler
tarayıcıdakiyle birebir aynı kodu çalıştırır.

---

## Oda sahipliği

Odayı kuran kişi **kurucu**dur (lobide etiketle görünür) ve tur sayısı ile modu
o ayarlar. Kurucu odadan çıkarsa **oda kapanır**: herkes ana ekrana düşer ve
oda verisi silinir. Yanında başkası varken tek dokunuşla kapanmasın diye geri
düğmesi ikinci dokunuşta onaylatır.

Kurucunun sadece bağlantısı koparsa oda kapanmaz — geri dönebilir. Bu sırada
oyun kilitlenmesin diye başlatma yetkisi geçici olarak en erken katılan
çevrimiçi oyuncuya geçer.

## Bilinen sınırlar

- Oyun başladıktan sonra katılanlar o turda izleyici olur; sıraya bir sonraki
  turda eklenirler.
- Kurucusu kapatmadan terk edilen odalar veritabanında kalır (birkaç KB).
  24 saatten eski bir oda kodu yeniden kullanılırken otomatik temizlenir.
- Sesli iletişim uygulamada yok — oyun zaten konuşarak oynanıyor.
- 4 harfli oda kodunu bilen odaya katılabilir (misafir olarak da). Odalar
  24 saatte kapandığı için kodun ömrü sınırlı.
- Odadaki oyuncular oyun durumunu (faz, takımlar, tur) yazabilir; güven düzeyi
  odanın geri kalanıyla aynıdır. Gizli olan hedef ve tahmin ibreleridir, onlar
  kural düzeyinde korunur.
- Apple ile giriş kodu hazır ama kapalı: `public/js/auth.js` içindeki
  `PROVIDERS.apple` bayrağı, Apple Developer hesabı alınıp Firebase'de
  sağlayıcı açıldığında `true` yapılır.
