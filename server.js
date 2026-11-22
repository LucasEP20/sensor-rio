require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const twilio = require("twilio");
const sgMail = require("@sendgrid/mail");

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- PERSISTENCIA EN DISCO ---
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "historial.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let db = {
  historial: [
    {
      hora: new Date().toLocaleTimeString(),
      estado: "NORMAL",
      nivel: 50,
      angulo: 35,
    },
  ],
  eventos: [],
};

// Cargar historial previo si existe
if (fs.existsSync(DATA_FILE)) {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.historial) && parsed.historial.length > 0) {
      db.historial = parsed.historial;
    }
    if (Array.isArray(parsed.eventos)) {
      db.eventos = parsed.eventos;
    }
    console.log(
      `[Persistencia] Cargadas ${db.historial.length} lecturas y ${db.eventos.length} eventos previos.`,
    );
  } catch (err) {
    console.error(
      "[Persistencia Error] No se pudo leer historial.json, iniciando limpio:",
      err.message,
    );
  }
}

function guardarEnDisco() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
  } catch (err) {
    console.error(
      "[Persistencia Error] Fallo al guardar en disco:",
      err.message,
    );
  }
}

function agregarEventoBitacora(hora, tipo, mensaje) {
  db.eventos.unshift({ hora, tipo, mensaje });
  if (db.eventos.length > 50) db.eventos.pop();
  guardarEnDisco();
}

// --- INICIALIZACIÓN TWILIO & SENDGRID ---
const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// --- ESTADO DE TELEMETRÍA, CONTROL Y ANTI-SPAM ---
let ultimaConexionNodo = 0;
let nodoEstabaOnline = false;
let modoCompuerta = "AUTO"; // 'AUTO' | 'ABRIR' | 'CERRAR'

let telemetriaExtra = {
  rssi: null,
  uptime: 0,
  resetReason: "Desconocido",
};

let ultimoEstadoConfirmado =
  db.historial[db.historial.length - 1]?.estado || "NORMAL";
let alertaCriticaActiva = false; // True solo si se llegó a notificar ALTO, BAJO o FALLA_SENSOR
let ultimoEnvioPorTipo = {}; // Timestamps para Cooldown
const COOLDOWN_MS = 45000; // 45 segundos mínimo entre notificaciones del mismo tipo

// Cola secuencial para que las notificaciones async nunca se pisen ni inviertan el orden
let colaNotificaciones = Promise.resolve();

function encolarNotificacion(estado, nivel, angulo, hora) {
  colaNotificaciones = colaNotificaciones
    .then(() => ejecutarEnvioNotificaciones(estado, nivel, angulo, hora))
    .catch((err) => console.error("[Cola Notificaciones Error]:", err));
}

async function ejecutarEnvioNotificaciones(estado, nivel, angulo, hora) {
  const ahora = Date.now();
  const ultimoEnvio = ultimoEnvioPorTipo[estado] || 0;

  if (ahora - ultimoEnvio < COOLDOWN_MS) {
    const restante = Math.ceil((COOLDOWN_MS - (ahora - ultimoEnvio)) / 1000);
    console.log(
      `[Cooldown] Notificación "${estado}" omitida (faltan ${restante}s para habilitar nuevo envío).`,
    );
    return;
  }

  ultimoEnvioPorTipo[estado] = ahora;

  let asunto = "";
  let mensajeTexto = "";
  let colorBanner = "#10b981";

  if (estado === "ALTO") {
    asunto = "🚨 ALERTA DE INUNDACIÓN - Nivel Crítico Alto en el Río";
    mensajeTexto = `[ALERTA INUNDACIÓN - ${hora}] Cota máxima superada (${nivel} cm). Compuerta abierta a ${angulo}° y sirena activada.`;
    colorBanner = "#ef4444";
  } else if (estado === "BAJO") {
    asunto = "⚠️ ADVERTENCIA DE SEQUÍA - Nivel Crítico Bajo en el Río";
    mensajeTexto = `[ALERTA SEQUÍA - ${hora}] Nivel mínimo detectado (${nivel} cm). Compuerta cerrada totalmente (${angulo}°) para retener caudal.`;
    colorBanner = "#f59e0b";
  } else if (estado === "FALLA_SENSOR") {
    asunto = "🔧 FALLA DE HARDWARE - Anomalía en Sensores Hall del Río";
    mensajeTexto = `[FALLA TÉCNICA - ${hora}] Lectura contradictoria en sensores D1 y D5 simultáneamente. Compuerta posicionada en modo seguro (${angulo}°).`;
    colorBanner = "#a855f7";
  } else if (estado === "NORMAL") {
    asunto = "✅ CAUDAL ESTABILIZADO - Retorno a Operación Normal";
    mensajeTexto = `[NORMALIZADO - ${hora}] El sistema volvió a parámetros normales (${nivel} cm). Compuerta regulada a ${angulo}°.`;
    colorBanner = "#10b981";
  }

  // 1. Envío SMS por Twilio
  if (
    twilioClient &&
    process.env.TWILIO_PHONE_FROM &&
    process.env.TWILIO_PHONE_TO
  ) {
    try {
      const sms = await twilioClient.messages.create({
        body: mensajeTexto,
        from: process.env.TWILIO_PHONE_FROM,
        to: process.env.TWILIO_PHONE_TO,
      });
      console.log(`[Twilio SMS OK] (${estado}) SID: ${sms.sid}`);
    } catch (error) {
      console.error("[Twilio SMS Error]:", error.message);
    }
  }

  // 2. Envío Email por SendGrid
  if (
    process.env.SENDGRID_API_KEY &&
    process.env.SENDGRID_EMAIL_FROM &&
    process.env.SENDGRID_EMAIL_TO
  ) {
    const mailOptions = {
      to: process.env.SENDGRID_EMAIL_TO,
      from: process.env.SENDGRID_EMAIL_FROM,
      subject: asunto,
      text: mensajeTexto,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 560px; margin: auto; border: 1px solid #cbd5e1; border-radius: 10px; overflow: hidden;">
          <div style="background-color: ${colorBanner}; color: #ffffff; padding: 16px 20px; font-size: 18px; font-weight: bold;">
            ${asunto}
          </div>
          <div style="padding: 20px; background-color: #f8fafc; color: #0f172a; line-height: 1.5;">
            <p style="margin-top: 0;">El nodo telemétrico de monitoreo reportó una transición confirmada:</p>
            <table style="width: 100%; border-collapse: collapse; margin: 15px 0; background: #ffffff;">
              <tr><td style="padding: 10px; border: 1px solid #e2e8f0;"><strong>Estado:</strong></td><td style="padding: 10px; border: 1px solid #e2e8f0;">${estado}</td></tr>
              <tr><td style="padding: 10px; border: 1px solid #e2e8f0;"><strong>Cota registrada:</strong></td><td style="padding: 10px; border: 1px solid #e2e8f0;">${nivel} cm</td></tr>
              <tr><td style="padding: 10px; border: 1px solid #e2e8f0;"><strong>Compuerta:</strong></td><td style="padding: 10px; border: 1px solid #e2e8f0;">${angulo}° (Modo ${modoCompuerta})</td></tr>
              <tr><td style="padding: 10px; border: 1px solid #e2e8f0;"><strong>Hora:</strong></td><td style="padding: 10px; border: 1px solid #e2e8f0;">${hora}</td></tr>
            </table>
          </div>
        </div>
      `,
    };

    try {
      await sgMail.send(mailOptions);
      console.log(
        `[SendGrid Email OK] (${estado}) Enviado a ${process.env.SENDGRID_EMAIL_TO}`,
      );
    } catch (error) {
      console.error(
        "[SendGrid Email Error]:",
        error.response ? error.response.body : error.message,
      );
    }
  }
}

// Watchdog interno: detecta si el sensor se desconecta por más de 8 segundos
setInterval(() => {
  if (ultimaConexionNodo > 0) {
    const sinSenalMs = Date.now() - ultimaConexionNodo;
    const onlineAhora = sinSenalMs <= 8000;

    if (nodoEstabaOnline && !onlineAhora) {
      nodoEstabaOnline = false;
      const hora = new Date().toLocaleTimeString();
      console.warn(
        `[Watchdog] ⚠️ Pérdida de conexión con el Sensor de Nivel (${hora})`,
      );
      agregarEventoBitacora(
        hora,
        "OFFLINE",
        "🔌 PÉRDIDA DE TELEMETRÍA: El sensor dejó de enviar datos (revisar Wi-Fi o alimentación)",
      );
    }
  }
}, 2000);

// --- ENDPOINTS API ---

// 1. Recepción de telemetría desde el microcontrolador
app.post("/api/rio", (req, res) => {
  const { estado, nivel, angulo, rssi, uptime, resetReason } = req.body;
  const horaActual = new Date().toLocaleTimeString();

  // Actualizar estado de conexión y diagnóstico
  ultimaConexionNodo = Date.now();
  if (!nodoEstabaOnline) {
    nodoEstabaOnline = true;
    agregarEventoBitacora(
      horaActual,
      "ONLINE",
      "🟢 CONEXIÓN ESTABLECIDA: Nodo sensor en línea enviando telemetría",
    );
  }

  telemetriaExtra = {
    rssi: rssi ?? telemetriaExtra.rssi,
    uptime: uptime ?? telemetriaExtra.uptime,
    resetReason: resetReason || telemetriaExtra.resetReason,
  };

  const registro = {
    hora: horaActual,
    estado,
    nivel,
    angulo,
  };

  db.historial.push(registro);
  if (db.historial.length > 200) db.historial.shift();

  // Detectar cambio real de estado
  if (estado && estado !== ultimoEstadoConfirmado) {
    ultimoEstadoConfirmado = estado;

    if (estado === "ALTO") {
      alertaCriticaActiva = true;
      agregarEventoBitacora(
        horaActual,
        "ALTO",
        `🚨 DESBORDE CONFIRMADO (${nivel} cm) — Compuerta a ${angulo}°`,
      );
      encolarNotificacion("ALTO", nivel, angulo, horaActual);
    } else if (estado === "BAJO") {
      alertaCriticaActiva = true;
      agregarEventoBitacora(
        horaActual,
        "BAJO",
        `⚠️ SEQUÍA CONFIRMADA (${nivel} cm) — Compuerta cerrada a ${angulo}°`,
      );
      encolarNotificacion("BAJO", nivel, angulo, horaActual);
    } else if (estado === "FALLA_SENSOR") {
      alertaCriticaActiva = true;
      agregarEventoBitacora(
        horaActual,
        "FALLA_SENSOR",
        `🔧 FALLA DE HARDWARE: Sensores D1 y D5 activos en simultáneo — Compuerta a ${angulo}°`,
      );
      encolarNotificacion("FALLA_SENSOR", nivel, angulo, horaActual);
    } else if (estado === "NORMAL") {
      agregarEventoBitacora(
        horaActual,
        "NORMAL",
        `✅ CAUDAL NORMALIZADO (${nivel} cm) — Compuerta a ${angulo}°`,
      );
      // Solo envía notificación de NORMAL si previamente hubo una alerta crítica real
      if (alertaCriticaActiva) {
        alertaCriticaActiva = false;
        encolarNotificacion("NORMAL", nivel, angulo, horaActual);
      }
    }
  }

  guardarEnDisco();
  console.log(
    `[${horaActual}] ${estado} (${nivel}cm) | Servo: ${angulo}° | Wi-Fi: ${rssi}dBm`,
  );

  // Respondemos con el modo actual para que el microcontrolador obedezca órdenes manuales
  res.status(200).json({ ok: true, modo: modoCompuerta });
});

// 2. Consulta del Frontend
app.get("/api/rio", (req, res) => {
  const ahora = Date.now();
  const segundosSinDatos =
    ultimaConexionNodo === 0
      ? null
      : Math.floor((ahora - ultimaConexionNodo) / 1000);
  const nodoOnline = ultimaConexionNodo > 0 && segundosSinDatos <= 8;

  res.json({
    nodoOnline,
    segundosSinDatos,
    modoCompuerta,
    telemetriaExtra,
    actual: db.historial[db.historial.length - 1],
    historial: db.historial.slice(-30), // Últimos 30 puntos para el gráfico
    eventos: db.eventos.slice(0, 15),
  });
});

// 3. Control manual de compuerta desde el Frontend
app.post("/api/modo", (req, res) => {
  const { modo } = req.body;
  if (["AUTO", "ABRIR", "CERRAR"].includes(modo)) {
    modoCompuerta = modo;
    const hora = new Date().toLocaleTimeString();
    agregarEventoBitacora(
      hora,
      "NORMAL",
      `🎛️ CONTROL OPERADOR: Modo de compuerta cambiado a "${modo}"`,
    );
    console.log(`[Operador] Modo compuerta cambiado a: ${modo}`);
    res.json({ ok: true, modoCompuerta });
  } else {
    res.status(400).json({ error: "Modo inválido" });
  }
});

// 4. Exportar historial completo a CSV (para abrir en Excel)
app.get("/api/exportar", (req, res) => {
  const filas = ["Hora,Estado,Nivel_cm,Angulo_Compuerta"];
  db.historial.forEach((r) => {
    filas.push(`${r.hora},${r.estado},${r.nivel},${r.angulo}`);
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="historial_rio.csv"',
  );
  res.send(filas.join("\n"));
});

// --- MÓDULO DE CLIMA (OPEN-METEO) + ANÁLISIS CONTEXTUAL CON GEMINI ---

async function obtenerClimaCuenca() {
  const lat = process.env.RIO_LAT || "-32.4075";
  const lon = process.env.RIO_LON || "-63.2402";
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=precipitation,rain,weather_code&hourly=precipitation_probability,precipitation&forecast_days=1&timezone=auto`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Error Open-Meteo: ${res.status}`);
  const data = await res.json();

  const horaActualIdx = new Date().getHours();
  const probProximasHoras = (
    data.hourly?.precipitation_probability || []
  ).slice(horaActualIdx, horaActualIdx + 4);
  const lluviaProximasHoras = (data.hourly?.precipitation || []).slice(
    horaActualIdx,
    horaActualIdx + 4,
  );

  return {
    lluviaActualMm: data.current?.rain ?? 0,
    precipitacionTotalMm: data.current?.precipitation ?? 0,
    probabilidadProximas4h: probProximasHoras,
    lluviaEstimadaProximas4hMm: lluviaProximasHoras,
  };
}

app.post("/api/analizar-ia", async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res
      .status(400)
      .json({ error: "Falta configurar GEMINI_API_KEY en el archivo .env" });
  }

  try {
    const clima = await obtenerClimaCuenca();
    const actual = db.historial[db.historial.length - 1] || {
      estado: "NORMAL",
      nivel: 50,
      angulo: 35,
    };
    const ultimasLecturas = db.historial.slice(-12);
    const ultimosEventos = db.eventos.slice(0, 6);
    const ubicacion =
      process.env.UBICACION_SENSOR ||
      "Tramo estándar de río sin referencias topográficas cargadas.";

    const prompt = `
Sos un especialista en hidrología urbana y sistemas de control de crecidas. Analizá la situación actual de este nodo de monitoreo IoT y devolvé un informe breve, claro y accionable en español (máximo 140 palabras, sin saludos introductorios).

DATOS DEL PUNTO DE MEDICIÓN:
- Ubicación y entorno físico: ${ubicacion}
- Estado actual del sensor Hall: ${actual.estado} (Cota de referencia: ${actual.nivel} cm)
- Posición actual de compuerta SG90: ${actual.angulo}° (Modo: ${modoCompuerta})
- Señal Wi-Fi del nodo: ${telemetriaExtra.rssi ?? "N/D"} dBm

DATOS METEOROLÓGICOS EN TIEMPO REAL (Cuenca / Zona del sensor):
- Lluvia actual: ${clima.lluviaActualMm} mm
- Probabilidad de lluvia próximas 4 horas (%): ${JSON.stringify(clima.probabilidadProximas4h)}
- Precipitación estimada próximas 4 horas (mm): ${JSON.stringify(clima.lluviaEstimadaProximas4hMm)}

HISTORIAL RECIENTE:
- Últimas lecturas: ${JSON.stringify(ultimasLecturas)}
- Eventos recientes: ${JSON.stringify(ultimosEventos)}

INSTRUCCIONES DE RESPUESTA:
1. Evaluá el riesgo combinado (nivel actual + aporte de desagües pluviales por lluvia y características del lugar).
2. Indicá si la apertura actual de la compuerta (${actual.angulo}°) es adecuada o si conviene anticipar maniobras.
3. Señalá cualquier anomalía técnica si ves cortes de señal o rebotes frecuentes.
Usá viñetas cortas y lenguaje técnico preciso.
`;

    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

    const aiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 350,
        },
      }),
    });

    const aiData = await aiRes.json();
    if (!aiRes.ok) {
      throw new Error(aiData.error?.message || "Error en la API de Gemini");
    }

    const textoAnalisis =
      aiData.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Sin respuesta generada.";
    const hora = new Date().toLocaleTimeString();

    agregarEventoBitacora(
      hora,
      "NORMAL",
      "✨ DIAGNÓSTICO IA: Evaluación hidrológica y pluvial generada con Gemini",
    );

    res.json({
      ok: true,
      hora,
      clima,
      analisis: textoAnalisis,
    });
  } catch (error) {
    console.error("[Gemini IA Error]:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor IoT corriendo en http://localhost:${PORT}`);
});
