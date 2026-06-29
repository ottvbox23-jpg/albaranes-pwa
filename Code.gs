// ============================================================
// ESCÁNER DE ALBARANES — Google Apps Script (Backend)
// Versión con Gemini (Extracción específica Elektres/800)
// ============================================================
// CONFIGURACIÓN: pon aquí tu clave de Gemini
var GEMINI_API_KEY = "TU_CLAVE_GEMINI_AQUI"; // AIzaSy...
var CARPETA_RAIZ   = "Albaranes";

// ── POST: recibe foto + datos desde la PWA ───────────────────
function doPost(e) {
  try {
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
  var imagen       = datos.image   || datos.imagen  || '';
  var mime         = datos.mime    || 'image/jpeg';
  var lat          = datos.lat     || '';
  var lng          = datos.lng     || '';
  var direccionGPS = datos.direccion || (lat && lng ? lat + ', ' + lng : 'No disponible');

  // 1. Extraer número y dirección con Gemini
  var datosIA = extraerDatosConGemini(imagen, mime);
  var numero  = datosIA.numero;
  
  // Si la IA encontró el cliente/dirección, lo usamos. Si no, usamos el GPS por defecto.
  var ubicacionFinal = (datosIA.ubicacion && datosIA.ubicacion !== 'NO_ENCONTRADO') ? datosIA.ubicacion : direccionGPS;

  // 2. Fecha actual
  var fecha = new Date();

  // 3. Carpeta del mes en Google Drive
  var nombreMes = Utilities.formatDate(fecha, Session.getScriptTimeZone(), "yyyy - MMMM");
  nombreMes = nombreMes.charAt(0).toUpperCase() + nombreMes.slice(1);
  var carpetaRaiz = obtenerOCrearCarpeta(CARPETA_RAIZ);
  var carpetaMes  = obtenerOCrearCarpeta(nombreMes, carpetaRaiz);

  // 4. Nombre del archivo PDF (Usa el número de albarán limpio)
  var fechaArchivo = Utilities.formatDate(fecha, Session.getScriptTimeZone(), "yyyyMMdd_HHmm");
  var numLimpio    = numero.replace(/[^a-zA-Z0-9\-]/g, '_');
  var nombrePDF    = 'ALB_' + numLimpio + '_' + fechaArchivo + '.pdf';

  // 5. Generar PDF (2 Páginas)
  var pdfBlob = generarPDF(imagen, mime, numero, fecha, ubicacionFinal, lat, lng, direccionGPS);
  pdfBlob.setName(nombrePDF);
  var archivoPDF = carpetaMes.createFile(pdfBlob);

  // 6. Guardar imagen original en JPG
  var imgBlob = Utilities.newBlob(Utilities.base64Decode(imagen), mime, 'ALB_' + numLimpio + '_' + fechaArchivo + '.jpg');
  carpetaMes.createFile(imgBlob);

  // 7. Registrar en Google Sheets (Excel)
  registrarEnHoja(numero, fecha, ubicacionFinal, archivoPDF.getUrl(), nombrePDF);

  return { nombre: nombrePDF, carpeta: nombreMes, pdfUrl: archivoPDF.getUrl() };
}

// ── Llamada a Gemini para extraer los 2 datos exactos ────────
function extraerDatosConGemini(imagenBase64, mime) {
  try {
    var url  = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + GEMINI_API_KEY;
    
    // Aquí está el prompt detallado basado en tu ejemplo de Elektres
    var prompt = 'Eres un experto en extracción de datos logísticos. Analiza esta imagen de un albarán y extrae 2 datos exactos:\n' +
                 '1) "numero_albaran": Busca en el bloque "Albarán de entrega" el número que empieza por 800 (ej. 80060483). Si tiene una barra y más números (ej. 80060483/2000...), extrae SOLO la primera parte que empieza por 800.\n' +
                 '2) "ubicacion": Busca el recuadro "Dirección de entrega". Ignora la palabra "Organización" y extrae la primera línea real de texto que haya debajo (suele ser el nombre de la empresa destino, como "RUBIX IBERIA SA").\n' +
                 'Devuelve ÚNICAMENTE un JSON válido sin formato markdown: {"numero_albaran": "...", "ubicacion": "..."}. Si no encuentras alguno, usa "NO_ENCONTRADO".';

    var body = JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: mime, data: imagenBase64 } },
          { text: prompt }
        ]
      }],
      generationConfig: { maxOutputTokens: 150, temperature: 0 }
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
    var ubicacion = parsed.ubicacion || 'NO_ENCONTRADO';
    
    // Limpieza de seguridad por si la IA devuelve la fecha pegada con la barra
    if (numero !== 'NO_ENCONTRADO') {
      numero = numero.split('/')[0].trim();
    } else {
      numero = 'SIN-NUMERO';
    }

    return { numero: numero, ubicacion: ubicacion };

  } catch(e) {
    Logger.log('Error Gemini: ' + e.toString());
    return { numero: 'SIN-NUMERO', ubicacion: 'NO_ENCONTRADO' };
  }
}

// ── Generación del PDF ─────────────────────────────────────────
function generarPDF(imagenBase64, mime, numero, fecha, ubicacionFinal, lat, lng, direccionGPS) {
  var fechaLarga = Utilities.formatDate(fecha, Session.getScriptTimeZone(), "EEEE, d 'de' MMMM 'de' yyyy");
  var hora       = Utilities.formatDate(fecha, Session.getScriptTimeZone(), "HH:mm");
  var mapsUrl    = (lat && lng) ? 'https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lng : '';
  var imageSrc   = 'data:' + mime + ';base64,' + imagenBase64;

  var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
    'body{font-family:Arial,sans-serif;margin:0;padding:0;color:#1a1a1a;font-size:13px}' +
    '.page{box-sizing:border-box;padding:28px;min-height:100%;page-break-after:always}' +
    '.page:last-child{page-break-after:avoid}' +
    '.photo-container{width:100%;text-align:center}' +
    '.photo-container img{max-width:100%;height:auto;max-height:90vh;border-radius:6px;border:1px solid #e0e0e0;object-fit:contain}' +
    '.photo-title{font-size:14px;color:#666;font-weight:700;margin-bottom:15px;text-transform:uppercase;letter-spacing:.05em}' +
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
    
    /* PÁGINA 1: Foto */
    '<div class="page">' +
    '  <div class="photo-container">' +
    '    <div class="photo-title">Documento Original Digitalizado</div>' +
    '    <img src="' + imageSrc + '" alt="Albarán"/>' +
    '  </div>' +
    '</div>' +
    
    /* PÁGINA 2: Datos */
    '<div class="page">' +
    '  <div class="header">' +
    '    <div><h1>Datos de Entrega</h1></div>' +
    '    <div><div class="num-label">Nº Albarán</div><div class="num">' + numero + '</div></div>' +
    '  </div>' +
    '  <div class="grid">' +
    '    <div class="dato"><label>Fecha de Entrega</label><span>' + fechaLarga + '</span></div>' +
    '    <div class="dato"><label>Hora de Entrega</label><span>' + hora + '</span></div>' +
    '    <div class="dato full"><label>Destinatario / Ubicación (Extraído por IA)</label><span>' + ubicacionFinal + '</span></div>' +
         (lat && lng ? 
    '    <div class="dato full"><label>Geolocalización GPS de la entrega</label>' +
    '         <span>Dirección: ' + direccionGPS + '<br>Coordenadas: ' + lat + ', ' + lng + '<br>' +
              (mapsUrl ? '<a class="maps-link" href="' + mapsUrl + '" target="_blank">📍 Abrir ubicación en Google Maps</a>' : '') +
    '         </span>' +
    '    </div>' : '') +
    '  </div>' +
    '  <div class="footer"><span>Generado automáticamente</span><span>' + fecha.toISOString() + '</span></div>' +
    '</div>' +
    '</body></html>';

  return HtmlService.createHtmlOutput(html).getAs(MimeType.PDF).setName('albaran.pdf');
}

// ── Registro en Google Sheets (5 columnas) ───────────────────
function registrarEnHoja(numero, fecha, ubicacion, urlPDF, nombrePDF) {
  var carpeta = obtenerOCrearCarpeta(CARPETA_RAIZ);
  var it = carpeta.getFilesByName('Registro_albaranes');
  var ss;
  if (it.hasNext()) {
    ss = SpreadsheetApp.open(it.next());
  } else {
    ss = SpreadsheetApp.create('Registro_albaranes');
    var h = ss.getActiveSheet();
    h.setName('Albaranes');
    h.getRange(1,1,1,5).setValues([['Nº Albarán','Fecha','Hora','Ubicación','PDF']]);
    h.getRange(1,1,1,5).setFontWeight('bold').setBackground('#185FA5').setFontColor('#ffffff');
    DriveApp.getFileById(ss.getId()).moveTo(carpeta);
  }
  var hoja = ss.getSheetByName('Albaranes') || ss.getActiveSheet();
  
  hoja.appendRow([
    numero,
    Utilities.formatDate(fecha, Session.getScriptTimeZone(), 'dd/MM/yyyy'),
    Utilities.formatDate(fecha, Session.getScriptTimeZone(), 'HH:mm'),
    ubicacion, // Aquí irá el nombre de la empresa, ej: "RUBIX IBERIA SA"
    urlPDF
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
