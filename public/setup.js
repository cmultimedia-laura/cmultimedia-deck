/* ES5 — construit l'adresse https à partir de l'adresse actuelle. */
(function () {
  var host = window.location.hostname, port = Number(window.location.port || 80) + 1;
  var url = 'https://' + host + ':' + port + '/';
  var a = document.getElementById('go-https'); a.href = url;
  document.getElementById('https-url').textContent = url;
  var x = new XMLHttpRequest();
  x.open('GET', '/api/ping', true);
  x.send(null);
})();
