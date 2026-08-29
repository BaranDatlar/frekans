// İnce başlatıcı. Asıl uygulama main.js'te; buradan dinamik import edilir ki
// Firebase ayarları eksikse (config.js doldurulmamışsa) beyaz ekran yerine
// anlaşılır bir mesaj gösterebilelim.

document.querySelector('#screen-boot').classList.add('active');

try {
  const { start } = await import('./main.js');
  await start();
} catch (err) {
  console.error(err);
  const box = document.querySelector('#boot-status');
  box.textContent = err?.message || 'Uygulama başlatılamadı.';
  box.classList.add('error');
  document.querySelector('#screen-boot .spinner')?.remove();
}
