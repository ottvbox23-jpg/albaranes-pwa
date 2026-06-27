// ============================================================
//  ESCÁNER DE ALBARANES — Google Apps Script (Opción B)
//  Pega este código en script.google.com y despliega como
//  "Aplicación web" con acceso: "Cualquiera"
// ============================================================

// 📁 CONFIGURA AQUÍ tu carpeta raíz en Google Drive
//    Déjalo vacío ("") para usar "Mi unidad" directamente
var CARPETA_RAIZ_NOMBRE = "Albaranes";

// ============================================================

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);

    var imageBase64  = payload.image;        // base64 sin cabecera
    var imageMime    = payload.mime || "image/jpeg";
    var numeroAlbaran = payload.numero || "SIN-NUMERO";
    var fechaHora    = payload.fechaHora;
    var lat          = payload.lat;
    var lng          = payload.lng;
    var direccion    = payload.direccion || "";

    // ---- 1. Obtener / crear carpeta de destino ----
    var carpetaDestino = obtenerOCrearCarpeta(numeroAlbaran);

    // ---- 2. Guardar la imagen original ----
    var nombreImagen = "ALB_" + limpiarNombre(numeroAlbaran) + "_original.jpg";
    var imgBlob = Utilities.newBlob(
      Utilities.base64Decode(imageBase64),
      imageMime,
      nombreImagen
    );
    var archivoImagen = carpetaDestino.createFile(imgBlob);

    // ---- 3. Crear el PDF con los datos ----
    var nombrePDF = "ALB_" + limpiarNombre(numeroAlbaran) + "_" + fechaCorta() + ".pdf";
    var htmlContent = generarHTMLParaPDF(
      numeroAlbaran, fechaHora, lat, lng, direccion,
      archivoImagen.getId()
    );

    var blob = HtmlService
      .createHtmlOutput(htmlContent)
      .getBlob()
      .setName(nombrePDF);

    // Convertir HTML a PDF
    var pdfBlob = blob.copyBlob();
    pdfBlob.setName(nombrePDF);

    // Usar Drive para generar PDF a partir del HTML
    var docTemp = DocumentApp.create("_temp_albaran_" + numeroAlbaran);
    var body = docTemp.getBody();

    body.appendParagraph("ALBARÁN: " + numeroAlbaran)
        .setHeading(DocumentApp.ParagraphHeading.HEADING1);

    body.appendParagraph("Fecha y hora: " + fechaHora);
    body.appendParagraph("Número de albarán: " + numeroAlbaran);

    if (direccion) {
      body.appendParagraph("Dirección: " + direccion);
    }
    if (lat && lng) {
      body.appendParagraph("Coordenadas GPS: " + lat + ", " + lng);
      body.appendParagraph("Ver en Maps: https://maps.google.com/?q=" + lat + "," + lng);
    }

    body.appendParagraph(" ");
    body.appendParagraph("Imagen del albarán firmado:")
        .setHeading(DocumentApp.ParagraphHeading.HEADING2);

    // Insertar imagen en el documento
    var imgBlobParaDoc = Utilities.newBlob(
      Utilities.base64Decode(imageBase64),
      imageMime,
      "albaran.jpg"
    );
    var inlineImg = body.appendImage(imgBlobParaDoc);
    // Ajustar tamaño máximo 500px ancho
    var anchoPx = inlineImg.getWidth();
    if (anchoPx > 500) {
      var ratio = 500 / anchoPx;
      inlineImg.setWidth(500);
      inlineImg.setHeight(Math.round(inlineImg.getHeight() * ratio));
    }

    body.appendParagraph(" ");
    body.appendParagraph("Documento generado automáticamente · Escáner de Albaranes")
        .setItalic(true);

    docTemp.saveAndClose();

    // Exportar como PDF
    var docId = docTemp.getId();
    var pdfBlobFinal = DriveApp.getFileById(docId)
      .getBlob()
      .setName(nombrePDF);

    // Guardar PDF en la carpeta
    var archivoPDF = carpetaDestino.createFile(pdfBlobFinal);

    // Eliminar documento temporal
    DriveApp.getFileById(docId).setTrashed(true);

    // ---- 4. Responder con el enlace al PDF ----
    return ContentService
      .createTextOutput(JSON.stringify({
        ok: true,
        pdfUrl: "https://drive.google.com/file/d/" + archivoPDF.getId() + "/view",
        pdfId: archivoPDF.getId(),
        nombre: nombrePDF,
        carpeta: carpetaDestino.getName()
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch(err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ---- Función de prueba GET (para verificar que el script está activo) ----
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, status: "Escáner de Albaranes activo" }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
//  UTILIDADES
// ============================================================

function obtenerOCrearCarpeta(numeroAlbaran) {
  var raiz;

  if (CARPETA_RAIZ_NOMBRE === "") {
    raiz = DriveApp.getRootFolder();
  } else {
    var carpetasRaiz = DriveApp.getFoldersByName(CARPETA_RAIZ_NOMBRE);
    raiz = carpetasRaiz.hasNext()
      ? carpetasRaiz.next()
      : DriveApp.createFolder(CARPETA_RAIZ_NOMBRE);
  }

  // Subcarpeta por mes: "2025-06 Junio"
  var ahora = new Date();
  var nombreMes = ahora.toLocaleString("es-ES", { month: "long", year: "numeric" });
  var prefMes   = Utilities.formatDate(ahora, Session.getScriptTimeZone(), "yyyy-MM");
  var nombreCarpetaMes = prefMes + " " + capitalizar(nombreMes);

  var subCarpetas = raiz.getFoldersByName(nombreCarpetaMes);
  var carpetaMes  = subCarpetas.hasNext()
    ? subCarpetas.next()
    : raiz.createFolder(nombreCarpetaMes);

  return carpetaMes;
}

function limpiarNombre(nombre) {
  return nombre.replace(/[^a-zA-Z0-9\-_]/g, "_").substring(0, 40);
}

function fechaCorta() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function capitalizar(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function generarHTMLParaPDF(numero, fechaHora, lat, lng, direccion, imgId) {
  var mapsUrl = (lat && lng)
    ? "https://maps.google.com/?q=" + lat + "," + lng
    : null;

  return '<html><body style="font-family:Arial,sans-serif;padding:20px;">'
    + '<h1 style="color:#1a4f8a;">Albarán: ' + numero + '</h1>'
    + '<hr/>'
    + '<p><strong>Fecha y hora:</strong> ' + fechaHora + '</p>'
    + '<p><strong>Número de albarán:</strong> ' + numero + '</p>'
    + (direccion ? '<p><strong>Dirección:</strong> ' + direccion + '</p>' : '')
    + (mapsUrl ? '<p><strong>GPS:</strong> ' + lat + ', ' + lng + '</p>' : '')
    + '</body></html>';
}
