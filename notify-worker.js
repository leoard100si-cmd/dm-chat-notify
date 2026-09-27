// Alternativa 100% GRÁTIS ao Cloud Functions — não precisa de plano Blaze
// nem de cartão de crédito. É um script Node.js que fica rodando num
// servidor grátis (Render.com) escutando o banco de dados e mandando a
// notificação push toda vez que chega mensagem nova.
//
// A chave da service account vem de uma variável de ambiente
// (FIREBASE_SERVICE_ACCOUNT), não de um arquivo — assim dá pra rodar no
// Render sem subir esse arquivo sensível pro GitHub.
//
// Também sobe um servidorzinho HTTP mínimo, só pra responder "OK" — é o
// que permite usar o plano Web Service grátis do Render (que exige um
// serviço com porta HTTP) em vez do "background worker", que é pago lá.

const http = require("http");
const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://dmchat-8a532-default-rtdb.firebaseio.com"
});

// Servidor HTTP só pra responder ao "pinger" (UptimeRobot/cron-job.org)
// e manter o serviço acordado no Render.
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Notificador do D.M rodando");
}).listen(PORT, () => console.log("Servidor de saúde na porta " + PORT));

const db = admin.database();
const messaging = admin.messaging();

// Mesma lista de usuários do dm-chat.html (mantenha as duas em sincronia).
const USERS = ["NightFall", "Flamenguista", "Kaw", "Leo", "Khotoziko", "Sheikada", "eren"];

function previewText(m) {
  if (m.type === "text") return m.text;
  if (m.type === "image") return "enviou uma foto";
  if (m.type === "video") return "enviou um vídeo";
  if (m.type === "audio") return "enviou um áudio";
  return "enviou um arquivo";
}

async function sendToUser(username, title, body, dataChat) {
  const tokensSnap = await db.ref("tokens/" + username).once("value");
  const tokens = Object.keys(tokensSnap.val() || {});
  if (tokens.length === 0) return;

  // Manda só "data" (sem o campo "notification"): se mandar os dois juntos,
  // o navegador mostra a notificação sozinho E o firebase-messaging-sw.js
  // mostra de novo manualmente, duplicando o aviso.
  const response = await messaging.sendEachForMulticast({
    tokens,
    data: { title, body, chat: dataChat },
    webpush: { fcmOptions: { link: "./" } }
  });

  // Remove tokens inválidos (app desinstalado, permissão revogada, etc.)
  const removals = [];
  response.responses.forEach((r, i) => {
    if (!r.success) removals.push(db.ref("tokens/" + username + "/" + tokens[i]).remove());
  });
  await Promise.all(removals);
}

// Evita disparar notificação de mensagens antigas quando o script liga.
const startedAt = Date.now();

db.ref("messages/general").on("child_added", async snap => {
  const m = snap.val();
  if (!m || !m.from || m.timestamp < startedAt) return;
  const recipients = USERS.filter(u => u !== m.from);
  const body = previewText(m);
  await Promise.all(recipients.map(u => sendToUser(u, "Geral · " + m.from, body, "general")));
});

// Escuta cada conversa privada que já existe e as que forem criadas depois.
db.ref("messages/private").on("child_added", chatSnap => {
  const chatId = chatSnap.key;
  db.ref("messages/private/" + chatId).on("child_added", async snap => {
    const m = snap.val();
    if (!m || !m.from || m.timestamp < startedAt) return;
    const [a, b] = chatId.split("_");
    const to = m.from === a ? b : a;
    if (!to || to === m.from) return;
    const body = previewText(m);
    await sendToUser(to, m.from, body, chatId);
  });
});

console.log("Notificador do Đ.M rodando... deixe essa janela/terminal aberto.");
