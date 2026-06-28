// ============================================================
// ESCÁNER DE ALBARANES — Google Apps Script (Backend)
// Versión con Gemini integrado — sin clave API en el móvil
// ============================================================
// CONFIGURACIÓN: pon aquí tu clave de Gemini
var GEMINI_API_KEY = "TU_CLAVE_GEMINI_AQUI"; // AIzaSy...
var CARPETA_RAIZ   = "Albaranes";

// ── POST: recibe foto + datos desde la PWA ───────────────────
function doPost(e) {
  try {
    // Soporta tanto JSON directo como FormData
    var payload;
    if (e.postData && e.postData.type === 'application/json') {
      payload = JSON.parse(e.postData.contents);
    } else if (e.parameter && e.parameter.data) {
      payload = JSON.parse(e.parameter.data);
    } else if (e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    } else {
      throw new Error('No se recibieron datos');
    }
    var resultado = procesarAlbaran(payload);
    return jsonResponseCORS({ ok: true, nombre: resultado.nombre, carpeta: resultado.carpeta, pdfUrl: resultado.pdfUrl });
  } catch(err) {
    return jsonResponseCORS({ ok: false, error: err.toString() });
  }
}

// ── GET: test de conectividad ────────────────────────────────
function doGet() {
  return jsonResponseCORS({ ok: true, msg: "Escáner de albaranes activo" });
}

// ── Lógica principal ─────────────────────────────────────────
function procesarAlbaran(datos) {
  var imagen    = datos.image   || datos.imagen  || '';
  var mime      = datos.mime    || 'image/jpeg';
  var fechaStr  = datos.fechaHora || '';
  var lat       = datos.lat     || '';
  var lng       = datos.lng     || '';
  var direccion = datos.direccion || (lat && lng ? lat + ', ' + lng : 'No disponible');

  // 1. Extraer número de albarán con Gemini
  var numero = extraerNumeroConGemini(imagen, mime);

  // 2. Fecha
  var fecha = new Date();

  // 3. Carpeta del mes
  var nombreMes = Utilities.formatDate(fecha, Session.getScriptTimeZone(), "yyyy - MMMM");
  nombreMes = nombreMes.charAt(0).toUpperCase() + nombreMes.slice(1);
  var carpetaRaiz = obtenerOCrearCarpeta(CARPETA_RAIZ);
  var carpetaMes  = obtenerOCrearCarpeta(nombreMes, carpetaRaiz);

  // 4. Nombre del archivo
  var fechaArchivo = Utilities.formatDate(fecha, Session.getScriptTimeZone(), "yyyyMMdd_HHmm");
  var numLimpio    = numero.replace(/[^a-zA-Z0-9\-]/g, '_');
  var nombrePDF    = 'ALB_' + numLimpio + '_' + fechaArchivo + '.pdf';

  // 5. Generar PDF
  var pdfBlob = generarPDF(imagen, mime, numero, fecha, direccion, lat, lng);
  pdfBlob.setName(nombrePDF);
  var archivoPDF = carpetaMes.createFile(pdfBlob);

  // 6. Guardar imagen original
  var imgBlob = Utilities.newBlob(Utilities.base64Decode(imagen), mime, 'ALB_' + numLimpio + '_' + fechaArchivo + '.jpg');
  carpetaMes.createFile(imgBlob);

  // 7. Registrar en hoja de cálculo
  registrarEnHoja(numero, fecha, direccion, lat, lng, archivoPDF.getUrl(), nombrePDF);

  return { nombre: nombrePDF, carpeta: nombreMes, pdfUrl: archivoPDF.getUrl() };
}

// ── Llamada a Gemini para extraer el número ──────────────────
function extraerNumeroConGemini(imagenBase64, mime) {
  try {
    var url  = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + GEMINI_API_KEY;
    var body = JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: mime, data: imagenBase64 } },
          { text: 'Eres un extractor de datos de documentos logísticos. Analiza esta imagen de un albarán de entrega y extrae el número de albarán principal siguiendo estas reglas en orden de prioridad: 1) Busca un número que empiece por 800 (formato 800XXXXX, puede tener 8 o más dígitos) — ese es el número de albarán. 2) Si no hay ninguno que empiece por 800, busca el número más prominente del documento, normalmente situado en la parte superior derecha o junto a la palabra "Albarán", "Nº", "Núm.", "Ref." o similar. 3) Ignora fechas, códigos postales, teléfonos y números de artículo o cantidad. Responde ÚNICAMENTE con JSON sin markdown: {"numero_albaran":"..."}. Si no encuentras ningún número usa "NO_ENCONTRADO".' }
        ]
      }],
      generationConfig: { maxOutputTokens: 100, temperature: 0 }
    });

    var response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: body,
      muteHttpExceptions: true
    });

    var json   = JSON.parse(response.getContentText());
    var texto  = json.candidates[0].content.parts[0].text || '{}';
    var parsed = JSON.parse(texto.replace(/```[a-z]*|```/g, '').trim());
    var numero = parsed.numero_albaran || 'NO_ENCONTRADO';
    return numero !== 'NO_ENCONTRADO' ? numero : 'SIN-NUMERO';

  } catch(e) {
    Logger.log('Error Gemini: ' + e.toString());
    return 'SIN-NUMERO';
  }
}

// ── Generación del PDF (CORREGIDO: 2 PÁGINAS Y FORMATO PDF REAL) ─────────────
function generarPDF(imagenBase64, mime, numero, fecha, direccion, lat, lng) {
  var fechaLarga = Utilities.formatDate(fecha, Session.getScriptTimeZone(), "EEEE, d 'de' MMMM 'de' yyyy");
  var hora       = Utilities.formatDate(fecha, Session.getScriptTimeZone(), "HH:mm");
  
  // URL oficial y dinámica de Google Maps para las coordenadas
  var mapsUrl    = (lat && lng) ? 'https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lng : '';
  var imageSrc   = 'data:' + mime + ';base64,' + imagenBase64;

  var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
    'body{font-family:Arial,sans-serif;margin:0;padding:0;color:#1a1a1a;font-size:13px}' +
    
    /* Manejo del salto de página en la conversión a PDF */
    '.page{box-sizing:border-box;padding:28px;min-height:100%;page-break-after:always}' +
    '.page:last-child{page-break-after:avoid}' +
    
    /* Contenedor para que la foto mantenga su tamaño original */
    '.photo-container{width:100%;text-align:center}' +
    '.photo-container img{max-width:100%;height:auto;max-height:90vh;border-radius:6px;border:1px solid #e0e0e0;object-fit:contain}' +
    '.photo-title{font-size:14px;color:#666;font-weight:700;margin-bottom:15px;text-transform:uppercase;letter-spacing:.05em}' +
    
    /* Diseño de la tabla de datos */
    '.header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #185FA5;padding-bottom:14px;margin-bottom:20px}' +
    '.header h1{font-size:20px;font-weight:700;color:#185FA5;margin:0}' +
    '.num{font-size:26px;font-weight:700;text-align:right}' +
    '.num-label{font-size:10px;color:#888;text-align:right;text-transform:uppercase;letter-spacing:.05em}' +
    '.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px}' +
    '.dato{background:#f5f7fa;border-radius:6px;padding:12px 14px}' +
    '.dato label{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:5px}' +
    '.dato span{font-size:14px;font-weight:500;line-height:1.4}' +
    '.full{grid-column:1/-1}' +
    '.maps-link{color:#185FA5;font-weight:700;text-decoration:none;display:inline-block;margin-top:5px}' +
    
    '.footer{margin-top:40px;padding-top:12px;border-top:.5px solid #eee;font-size:10px;color:#aaa;display:flex;justify-content:space-between}' +
    '</style></head><body>' +
    
    /* 📄 PÁGINA 1: La foto del albarán a tamaño completo */
    '<div class="page">' +
    '  <div class="photo-container">' +
    '    <div class="photo-title">Documento Original Digitalizado</div>' +
    '    <img src="' + imageSrc + '" alt="Albarán Fotografiado"/>' +
    '  </div>' +
    '</div>' +
    
    /* 📄 PÁGINA 2: Cuadro de metadatos de entrega */
    '<div class="page">' +
    '  <div class="header">' +
    '    <div><h1>Datos de Entrega</h1><div style="color:#666;font-size:11px;margin-top:3px">Información extraída y validación GPS</div></div>' +
    '    <div><div class="num-label">Nº Albarán</div><div class="num">' + numero + '</div></div>' +
    '  </div>' +
    '  <div class="grid">' +
    '    <div class="dato"><label>Fecha de Entrega</label><span>' + fechaLarga + '</span></div>' +
    '    <div class="dato"><label>Hora de Entrega</label><span>' + hora + '</span></div>' +
    '    <div class="dato full"><label>Lugar / Dirección</label><span>' + direccion + '</span></div>' +
         (lat && lng ? 
    '    <div class="dato full"><label>Ubicación Geoposicionada</label>' +
    '         <span>Coordenadas: ' + lat + ', ' + lng + '<br>' +
              (mapsUrl ? '<a class="maps-link" href="' + mapsUrl + '" target="_blank">📍 Abrir ubicación en Google Maps</a>' : '') +
    '         </span>' +
    '    </div>' : '') +
    '  </div>' +
    '  <div class="footer"><span>Generado automáticamente vía Escáner Albaranes PWA</span><span>' + fecha.toISOString() + '</span></div>' +
    '</div>' +
    
    '</body></html>';

  // AQUÍ ESTÁ EL CAMBIO CLAVE (MimeType.PDF) PARA QUE NO TE SALGA TEXTO PLANO EN DRIVE
  return HtmlService.createHtmlOutput(html).getAs(MimeType.PDF).setName('albaran.pdf');
}

// ── Registro en Google Sheets ────────────────────────────────
function registrarEnHoja(numero, fecha, dir, lat, lng, urlPDF, nombrePDF) {
  var carpeta = obtenerOCrearCarpeta(CARPETA_RAIZ);
  var it = carpeta.getFilesByName('Registro_albaranes');
  var ss;
  if (it.hasNext()) {
    ss = SpreadsheetApp.open(it.next());
  } else {
    ss = SpreadsheetApp.create('Registro_albaranes');
    var h = ss.getActiveSheet();
    h.setName('Albaranes');
    h.getRange(1,1,1,7).setValues([['Nº Albarán','Fecha','Hora','Ubicación','Latitud','Longitud','PDF']]);
    h.getRange(1,1,1,7).setFontWeight('bold').setBackground('#185FA5').setFontColor('#ffffff');
    DriveApp.getFileById(ss.getId()).moveTo(carpeta);
  }
  var hoja = ss.getSheetByName('Albaranes') || ss.getActiveSheet();
  hoja.appendRow([
    numero,
    Utilities.formatDate(fecha, Session.getScriptTimeZone(), 'dd/MM/yyyy'),
    Utilities.formatDate(fecha, Session.getScriptTimeZone(), 'HH:mm'),
    dir, lat, lng, urlPDF
  ]);
}

// ── Utilidades ───────────────────────────────────────────────
function obtenerOCrearCarpeta(nombre, padre) {
  var base = padre || DriveApp.getRootFolder();
  var it   = base.getFoldersByName(nombre);
  return it.hasNext() ? it.next() : base.createFolder(nombre);
}

function jsonResponseCORS(obj) {
  var output = ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
  return output;
}

function jsonResponse(obj) {
  return jsonResponseCORS(obj);
}
