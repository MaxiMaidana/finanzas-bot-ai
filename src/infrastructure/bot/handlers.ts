import { Telegraf, type Context } from "telegraf";
import { message } from "telegraf/filters";
import { extractTransaction } from "../../services/ai.service.js";
import {
  processTransactionData,
  cancelLastTransaction,
  cancelSpecificItem,
} from "../../services/finance.service.js";

// ---------------------------------------------------------------------------
// Palabras clave para detectar intención de anulación
// ---------------------------------------------------------------------------

const CANCEL_KEYWORDS = [
  "anular",
  "anulá",
  "anula",
  "anulo",
  "cancelar",
  "cancelá",
  "cancela",
  "cancelo",
  "deshacer",
  "deshacé",
  "borrar",
  "borrá",
  "borra",
  "borro",
  "eliminar",
  "eliminá",
  "elimina",
  "elimino",
  "undo",
];

const REEMBOLSO_KEYWORDS = [
  "reintegro",
  "reembolso",
  "devolución",
  "devolucion",
  "me devolvieron",
  "me reintegraron",
];

function detectIntent(text: string): "MODIFICAR_ANULAR" | "REGISTRAR_REINTEGRO" | "REGISTRAR_GASTO" {
  const lower = text.toLowerCase();
  if (CANCEL_KEYWORDS.some((kw) => lower.includes(kw))) return "MODIFICAR_ANULAR";
  if (REEMBOLSO_KEYWORDS.some((kw) => lower.includes(kw))) return "REGISTRAR_REINTEGRO";
  return "REGISTRAR_GASTO";
}

// ---------------------------------------------------------------------------
// Formateo de respuestas
// ---------------------------------------------------------------------------

function formatRegistroResponse(
  extraction: { merchant: string | null; items: Array<{ description: string; amount: number; category: string }> },
  transactionCount: number,
): string {
  const header = extraction.merchant
    ? `✅ *Registrado* — ${extraction.merchant}`
    : `✅ *Registrado*`;

  const lines = extraction.items.map(
    (item) => `  • ${item.description} — $${item.amount.toLocaleString("es-AR")} _(${item.category})_`,
  );

  const total = extraction.items.reduce((sum, i) => sum + i.amount, 0);

  return [
    header,
    "",
    ...lines,
    "",
    `*Total:* $${total.toLocaleString("es-AR")} (${transactionCount} ítem${transactionCount > 1 ? "s" : ""})`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Descarga de foto de Telegram como Buffer
// ---------------------------------------------------------------------------

async function downloadPhoto(ctx: Context): Promise<Buffer> {
  const photos = ctx.message && "photo" in ctx.message ? ctx.message.photo : undefined;
  if (!photos || photos.length === 0) {
    throw new Error("No se encontró la foto en el mensaje.");
  }

  // Tomar la versión de mayor resolución (último elemento)
  const fileId = photos[photos.length - 1].file_id;
  const fileLink = await ctx.telegram.getFileLink(fileId);

  const response = await fetch(fileLink.href);
  if (!response.ok) {
    throw new Error(`Error descargando la imagen: ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function downloadVoice(ctx: Context): Promise<Buffer> {
  const voice = ctx.message && "voice" in ctx.message ? ctx.message.voice : undefined;
  if (!voice) {
    throw new Error("No se encontró el audio en el mensaje.");
  }

  const fileLink = await ctx.telegram.getFileLink(voice.file_id);
  const response = await fetch(fileLink.href);
  if (!response.ok) {
    throw new Error(`Error descargando el audio: ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Setup de handlers
// ---------------------------------------------------------------------------

export function setupHandlers(bot: Telegraf): void {
  // --- Comando /start ---
  bot.start(async (ctx) => {
    await ctx.reply(
      "👋 ¡Hola! Soy tu bot de finanzas.\n\n" +
        "📝 Mandame un gasto en texto (ej: *Gasté $1500 en el super*)\n" +
        "📸 O mandame una foto de un ticket\n" +
        "🗑️ Escribí *anular* para cancelar el último gasto",
      { parse_mode: "Markdown" },
    );
  });

  // --- Handler de texto ---
  bot.on(message("text"), async (ctx) => {
    const telegramId = ctx.from.id.toString();
    const text = ctx.message.text;

    // Ignorar comandos que no tienen handler propio
    if (text.startsWith("/")) return;

    const intent = detectIntent(text);

    // Flujo de anulación
    if (intent === "MODIFICAR_ANULAR") {
      try {
        const result = await cancelLastTransaction(telegramId);
        const msg =
          result.type === "receipt"
            ? `🗑️ *Anulado:* ${result.description}\n*Total anulado:* $${result.totalAnulado.toLocaleString("es-AR")}`
            : `🗑️ *Anulado:* ${result.description} — $${result.totalAnulado.toLocaleString("es-AR")}`;
        await ctx.reply(msg, { parse_mode: "Markdown" });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Error desconocido";
        await ctx.reply(`⚠️ ${errorMsg}`);
      }
      return;
    }

    // Flujo de registro (gasto o reembolso)
    const processingMsg = await ctx.reply("Procesando... ⏳");

    try {
      const extraction = await extractTransaction({ text });

      // La IA detectó intención de anulación
      if (extraction.intent === "ANULAR") {
        const result = await cancelLastTransaction(telegramId);
        const msg =
          result.type === "receipt"
            ? `🗑️ *Anulado:* ${result.description}\n*Total anulado:* $${result.totalAnulado.toLocaleString("es-AR")}`
            : `🗑️ *Anulado:* ${result.description} — $${result.totalAnulado.toLocaleString("es-AR")}`;
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          processingMsg.message_id,
          undefined,
          msg,
          { parse_mode: "Markdown" },
        );
        return;
      }

      // La IA detectó intención de anulación de ítem específico
      if (extraction.intent === "ANULAR_ITEM" && extraction.itemToRemove) {
        const result = await cancelSpecificItem(telegramId, extraction.itemToRemove);
        const msg = result.remainingItems > 0
          ? `🗑️ *Eliminado:* ${result.description} — $${result.amount.toLocaleString("es-AR")}\n_Quedan ${result.remainingItems} ítem(s) en el recibo._`
          : `🗑️ *Eliminado:* ${result.description} — $${result.amount.toLocaleString("es-AR")}`;
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          processingMsg.message_id,
          undefined,
          msg,
          { parse_mode: "Markdown" },
        );
        return;
      }

      if (extraction.items.length === 0) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          processingMsg.message_id,
          undefined,
          "⚠️ No pude identificar gastos en tu mensaje. Intentá con más detalle.",
        );
        return;
      }

      const { transactionIds } = await processTransactionData(telegramId, {
        intent: extraction.intent === "REGISTRAR_REEMBOLSO" ? "REGISTRAR_REINTEGRO" : "REGISTRAR_GASTO",
        extraction,
      });

      const responseText = formatRegistroResponse(extraction, transactionIds.length);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        responseText,
        { parse_mode: "Markdown" },
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Error procesando el mensaje";
      const isQuota = errorMsg.includes("quota") || errorMsg.includes("rate") || errorMsg.includes("demand");
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        isQuota
          ? "⏳ Demasiadas consultas. Esperá unos segundos e intentá de nuevo."
          : `❌ ${errorMsg}`,
      );
    }
  });

  // --- Handler de foto ---
  bot.on(message("photo"), async (ctx) => {
    const telegramId = ctx.from.id.toString();
    const caption = ctx.message.caption ?? undefined;

    const processingMsg = await ctx.reply("Procesando imagen... 🔍");

    try {
      const imageBuffer = await downloadPhoto(ctx);

      const extraction = await extractTransaction({
        image: imageBuffer,
        text: caption,
      });

      if (extraction.items.length === 0) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          processingMsg.message_id,
          undefined,
          "⚠️ No pude identificar gastos en la imagen. Intentá con más detalle.",
        );
        return;
      }

      const { transactionIds } = await processTransactionData(telegramId, {
        intent: extraction.intent === "REGISTRAR_REEMBOLSO" ? "REGISTRAR_REINTEGRO" : "REGISTRAR_GASTO",
        extraction,
      });

      const responseText = formatRegistroResponse(extraction, transactionIds.length);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        responseText,
        { parse_mode: "Markdown" },
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Error procesando la imagen";
      const isQuota = errorMsg.includes("quota") || errorMsg.includes("rate") || errorMsg.includes("demand");
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        isQuota
          ? "⏳ Demasiadas consultas. Esperá unos segundos e intentá de nuevo."
          : `❌ ${errorMsg}`,
      );
    }
  });

  // --- Handler de audio/voz ---
  bot.on(message("voice"), async (ctx) => {
    const telegramId = ctx.from.id.toString();

    const processingMsg = await ctx.reply("Procesando audio... 🎙️");

    try {
      const audioBuffer = await downloadVoice(ctx);

      const extraction = await extractTransaction({
        audio: audioBuffer,
      });

      // La IA detectó intención de anulación en el audio
      if (extraction.intent === "ANULAR") {
        const result = await cancelLastTransaction(telegramId);
        const msg =
          result.type === "receipt"
            ? `🗑️ *Anulado:* ${result.description}\n*Total anulado:* $${result.totalAnulado.toLocaleString("es-AR")}`
            : `🗑️ *Anulado:* ${result.description} — $${result.totalAnulado.toLocaleString("es-AR")}`;
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          processingMsg.message_id,
          undefined,
          msg,
          { parse_mode: "Markdown" },
        );
        return;
      }

      // La IA detectó intención de anulación de ítem específico en el audio
      if (extraction.intent === "ANULAR_ITEM" && extraction.itemToRemove) {
        const result = await cancelSpecificItem(telegramId, extraction.itemToRemove);
        const msg = result.remainingItems > 0
          ? `🗑️ *Eliminado:* ${result.description} — $${result.amount.toLocaleString("es-AR")}\n_Quedan ${result.remainingItems} ítem(s) en el recibo._`
          : `🗑️ *Eliminado:* ${result.description} — $${result.amount.toLocaleString("es-AR")}`;
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          processingMsg.message_id,
          undefined,
          msg,
          { parse_mode: "Markdown" },
        );
        return;
      }

      if (extraction.items.length === 0) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          processingMsg.message_id,
          undefined,
          "⚠️ No pude identificar gastos en el audio. Intentá de nuevo con más detalle.",
        );
        return;
      }

      const { transactionIds } = await processTransactionData(telegramId, {
        intent: extraction.intent === "REGISTRAR_REEMBOLSO" ? "REGISTRAR_REINTEGRO" : "REGISTRAR_GASTO",
        extraction,
      });

      const responseText = formatRegistroResponse(extraction, transactionIds.length);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        responseText,
        { parse_mode: "Markdown" },
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Error procesando el audio";
      const isQuota = errorMsg.includes("quota") || errorMsg.includes("rate") || errorMsg.includes("demand");
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        isQuota
          ? "⏳ Demasiadas consultas. Esperá unos segundos e intentá de nuevo."
          : `❌ ${errorMsg}`,
      );
    }
  });
}
