import "dotenv/config";
import { Telegraf } from "telegraf";
import Fastify from "fastify";
import { prisma } from "./lib/prisma.js";
import { setupHandlers } from "./infrastructure/bot/handlers.js";

// ---------------------------------------------------------------------------
// Validación de variables de entorno
// ---------------------------------------------------------------------------

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN no está definido en .env");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Inicialización
// ---------------------------------------------------------------------------

const bot = new Telegraf(BOT_TOKEN);
const server = Fastify({ logger: false });

// Health-check
server.get("/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

// Registrar handlers del bot
setupHandlers(bot);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start() {
  // Verificar conexión a la DB
  await prisma.$connect();
  console.log("✅ Conectado a la base de datos");

  // Levantar Fastify
  const address = await server.listen({ port: 3000, host: "0.0.0.0" });
  console.log(`✅ Health-check server en ${address}/health`);

  // Lanzar bot en modo long-polling
  await bot.launch();
  console.log("✅ Bot de Telegram activo");
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal: string) {
  console.log(`\n⏹️  ${signal} recibido. Cerrando...`);
  bot.stop(signal);
  server.close().then(() => {
    prisma.$disconnect().then(() => {
      console.log("👋 Proceso terminado.");
      process.exit(0);
    });
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

start().catch((err) => {
  console.error("❌ Error al iniciar:", err);
  process.exit(1);
});
