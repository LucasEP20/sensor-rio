require('dotenv').config();
const express = require('express');
const path = require('path');
const twilio = require('twilio');
const sgMail = require('@sendgrid/mail');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Inicializar clientes de Twilio y SendGrid
const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// Historial en memoria para el gráfico del frontend
let historial = [
  { hora: new Date().toLocaleTimeString(), estado: 'NORMAL', nivel: 50, angulo: 35 }
];

// Control de estado previo para no enviar mensajes repetidos cada 3 segundos
let ultimoEstadoNotificado = 'NORMAL';

// Función encargada de despachar SMS y Email ante cambios críticos
async function enviarNotificaciones(estado, nivel, angulo, hora) {
  let asunto = '';
  let mensajeTexto = '';
  let colorBanner = '#10b981';

  if (estado === 'ALTO') {
    asunto = '🚨 ALERTA DE INUNDACIÓN - Nivel Crítico Alto en el Río';
    mensajeTexto = `[ALERTA INUNDACIÓN - ${hora}] Se superó la cota máxima (${nivel} cm). Compuerta abierta automáticamente a ${angulo}° y sirena activada.`;
    colorBanner = '#ef4444';
  } else if (estado === 'BAJO') {
    asunto = '⚠️ ADVERTENCIA DE SEQUÍA - Nivel Crítico Bajo en el Río';
    mensajeTexto = `[ALERTA SEQUÍA - ${hora}] Se detectó nivel mínimo (${nivel} cm). Compuerta cerrada totalmente (${angulo}°) para retener caudal.`;
    colorBanner = '#f59e0b';
  } else if (estado === 'NORMAL') {
    asunto = '✅ CAUDAL ESTABILIZADO - Retorno a Operación Normal';
    mensajeTexto = `[NORMALIZADO - ${hora}] El nivel del río volvió a parámetros seguros (${nivel} cm). Compuerta regulada a ${angulo}°.`;
    colorBanner = '#10b981';
  }

  // 1. Envío de SMS por Twilio
  if (twilioClient && process.env.TWILIO_PHONE_FROM && process.env.TWILIO_PHONE_TO) {
    try {
      const sms = await twilioClient.messages.create({
        body: mensajeTexto,
        from: process.env.TWILIO_PHONE_FROM,
        to: process.env.TWILIO_PHONE_TO
      });
      console.log(`[Twilio SMS OK] Enviado (SID: ${sms.sid})`);
    } catch (error) {
      console.error('[Twilio SMS Error]:', error.message);
    }
  } else {
    console.warn('[Twilio] Credenciales incompletas en .env, omitiendo SMS.');
  }

  // 2. Envío de Email por SendGrid
  if (process.env.SENDGRID_API_KEY && process.env.SENDGRID_EMAIL_FROM && process.env.SENDGRID_EMAIL_TO) {
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
            <p style="margin-top: 0;">El sistema telemétrico <strong>ESP8266</strong> reportó una transición de estado en el monitoreo del río:</p>
            <table style="width: 100%; border-collapse: collapse; margin: 15px 0; background: #ffffff;">
              <tr>
                <td style="padding: 10px; border: 1px solid #e2e8f0;"><strong>Estado detectado:</strong></td>
                <td style="padding: 10px; border: 1px solid #e2e8f0;">${estado}</td>
              </tr>
              <tr>
                <td style="padding: 10px; border: 1px solid #e2e8f0;"><strong>Cota registrada:</strong></td>
                <td style="padding: 10px; border: 1px solid #e2e8f0;">${nivel} cm</td>
              </tr>
              <tr>
                <td style="padding: 10px; border: 1px solid #e2e8f0;"><strong>Posición de compuerta:</strong></td>
                <td style="padding: 10px; border: 1px solid #e2e8f0;">${angulo}°</td>
              </tr>
              <tr>
                <td style="padding: 10px; border: 1px solid #e2e8f0;"><strong>Hora del evento:</strong></td>
                <td style="padding: 10px; border: 1px solid #e2e8f0;">${hora}</td>
              </tr>
            </table>
            <p style="font-size: 12px; color: #64748b; margin-bottom: 0;">Mensaje automático generado por el Sistema IoT de Control Hidrológico.</p>
          </div>
        </div>
      `
    };

    try {
      await sgMail.send(mailOptions);
      console.log(`[SendGrid Email OK] Correo enviado a ${process.env.SENDGRID_EMAIL_TO}`);
    } catch (error) {
      console.error('[SendGrid Email Error]:', error.response ? error.response.body : error.message);
    }
  } else {
    console.warn('[SendGrid] Credenciales incompletas en .env, omitiendo Email.');
  }
}

// Endpoint donde el NodeMCU envía los datos (POST)
app.post('/api/rio', (req, res) => {
  const { estado, nivel, angulo } = req.body;
  const horaActual = new Date().toLocaleTimeString();

  const registro = {
    hora: horaActual,
    estado,
    nivel,
    angulo
  };

  historial.push(registro);
  if (historial.length > 25) historial.shift();

  console.log(`[${horaActual}] Nivel: ${estado} (${nivel}cm) | Compuerta: ${angulo}°`);

  // Verificar si hubo cambio real de estado para disparar notificaciones
  if (estado && estado !== ultimoEstadoNotificado) {
    ultimoEstadoNotificado = estado;
    // Se ejecuta sin await para responder rápido al NodeMCU y evitar timeouts
    enviarNotificaciones(estado, nivel, angulo, horaActual);
  }

  res.status(200).json({ ok: true });
});

// Endpoint donde el Frontend consulta los datos (GET)
app.get('/api/rio', (req, res) => {
  res.json({
    actual: historial[historial.length - 1],
    historial
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor IoT corriendo en http://localhost:${PORT}`);
});