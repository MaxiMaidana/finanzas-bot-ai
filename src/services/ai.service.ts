import { generateText, Output } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";

// ---------------------------------------------------------------------------
// 1. Schema de extracción (Zod v4)
// ---------------------------------------------------------------------------

/** Se construye dinámicamente con las categorías reales de la DB. */
async function getCategoryNames(): Promise<[string, ...string[]]> {
  const rows = await prisma.category.findMany({ select: { name: true } });
  const names = rows.map((r: { name: string }) => r.name);
  if (names.length === 0) {
    throw new Error("No hay categorías en la base de datos. Corré el seed primero.");
  }
  return names as [string, ...string[]];
}

function buildExtractionSchema(categories: [string, ...string[]]) {
  const itemSchema = z.object({
    description: z.string().describe("Descripción breve del ítem o gasto"),
    amount: z.number().positive().describe("Monto del ítem en pesos"),
    category: z.enum(categories).describe("Categoría asignada al ítem"),
  });

  return z.object({
    intent: z
      .enum(["REGISTRAR_GASTO", "REGISTRAR_REEMBOLSO", "ANULAR", "ANULAR_ITEM"])
      .describe(
        "Intención del usuario: REGISTRAR_GASTO para gastos nuevos, REGISTRAR_REEMBOLSO para devoluciones, ANULAR si pide eliminar/borrar/anular/cancelar todo el último gasto, ANULAR_ITEM si pide eliminar un ítem específico del último gasto",
      ),
    merchant: z
      .string()
      .nullable()
      .describe("Nombre del comercio o null si no se identifica"),
    items: z
      .array(itemSchema)
      .describe("Lista de ítems extraídos. Vacío si el intent es ANULAR/ANULAR_ITEM o el usuario pidió excluir todos"),
    itemToRemove: z
      .string()
      .nullable()
      .describe("Descripción del ítem a eliminar cuando intent es ANULAR_ITEM. null en otros casos."),
  });
}

export type ExtractionResult = z.infer<ReturnType<typeof buildExtractionSchema>>;

// ---------------------------------------------------------------------------
// 2. Prompt del sistema
// ---------------------------------------------------------------------------

function buildSystemPrompt(categories: string[]): string {
  return `Sos un asistente financiero experto en clasificar gastos personales.
Tu trabajo es extraer ítems de un ticket de compra (imagen o texto) y clasificar cada uno.

═══════════════════════════════════════
REGLA #1 — LA PALABRA DEL USUARIO ES LEY
═══════════════════════════════════════
Si el usuario incluye un mensaje/caption junto a la imagen, ESA INSTRUCCIÓN TIENE PRIORIDAD ABSOLUTA:
- Si reclasifica un ítem (ej: "la papa es para los perros") → usá la categoría que indica ("Mascotas").
- Si dice que un ítem "ya se cargó", "no lo cargues", "ignoralo", "ese no", "ya lo registré" → EXCLUILO del array items. NO lo incluyas en la respuesta.
- Si dice que algo es un reintegro o devolución → registralo normalmente, el sistema se encarga del tipo.

═══════════════════════════════════════
REGLA #2 — CATEGORÍAS PERMITIDAS
═══════════════════════════════════════
Solo podés usar estas categorías: ${categories.join(", ")}.

Guía de clasificación cuando tengas dudas:
• Hogar/Supermercado → alimentos, limpieza, bazar, artículos de cocina. SOLO para comida y productos de supermercado/almacén. NO usar para herramientas, repuestos ni materiales de construcción.
• Servicios y Suscripciones → luz, gas, agua, internet, telefonía, streaming, clases particulares (inglés, música, etc.), cuotas de club, seguros, abonos mensuales, gimnasio mensual.
• Salud y Bienestar → farmacia, médico, psicólogo, kinesiólogo, obra social, sesiones de terapia, deportes puntuales (clase suelta de natación, etc.).
• Mascotas → alimento para animales, veterinaria, accesorios para mascotas.
• Delivery → pedidos de comida y bebida por apps (PedidosYa, Rappi, iFood, Didi Food, Uber Eats). Si el usuario pidió delivery o le trajeron algo a domicilio, SIEMPRE va acá aunque sea cerveza, pizza, etc.
• Salidas y Ocio → restaurantes (presencial), bares (presencial), cine, eventos, juntadas.
• Transporte → combustible, peajes, estacionamiento, SUBE, Uber, cabify, remís.
• Indumentaria → ropa, calzado, accesorios personales.
• Vivienda y Alquiler → alquiler mensual, expensas, depósito de alquiler, seguro de vivienda.
• Ahorro e Inversiones → compra de dólares, transferencia a cuenta de inversión, plazo fijo, crypto, aportes a cuentas de ahorro.
• Mantenimiento y Arreglos → ferretería, repuestos, herramientas, arreglos de la casa (plomero, electricista, pintura), mecánico del auto, service, gomería.
• Otros → solo si no encaja en ninguna de las anteriores.

Si no estás 100% seguro, usá los ejemplos de arriba como referencia. NUNCA inventes una categoría nueva.

═══════════════════════════════════════
REGLA #3 — FORMATO DE SALIDA
═══════════════════════════════════════
- Cada ítem debe tener: description, amount y category.
- El merchant es el nombre del comercio. Si no lo podés identificar, devolvé null.
- Los montos deben ser numéricos y positivos.
- No inventes ítems que no existan en el ticket o mensaje.
- Si después de aplicar las exclusiones del usuario no queda ningún ítem, devolvé el array items vacío.

═══════════════════════════════════════
REGLA #4 — ESPAÑOL ARGENTINO Y NÚMEROS
═══════════════════════════════════════
- El usuario habla en español argentino. Interpretá modismos y lunfardo con sentido común.
- Formatos de número argentinos (TODOS equivalen a lo mismo):
  "21 300", "21.300", "21300", "21 mil 300", "veintiún mil trescientos" → 21300
  "1 500", "1.500", "1500", "mil quinientos" → 1500
  "10 mil", "10.000", "10000" → 10000
  "2 lucas" = 2000, "15 lucas" = 15000
- El punto en números argentinos es separador de miles, NO decimal.
- Si el usuario dice "sacá", "quitá", "sacame", "de lo anterior sacá X" → quiere eliminar un ítem específico del último gasto (ANULAR_ITEM).

═══════════════════════════════════════
REGLA #5 — MENSAJES DE VOZ / AUDIO
═══════════════════════════════════════
- El usuario puede enviar audios breves e informales para registrar gastos.
- Interpretá el audio con sentido común: "10 mil panadería" = gasto de $10000, merchant "Panadería".
- "mil" = 1000, "10 mil" = 10000, "2 lucas" = 2000.
- Si solo menciona un monto y un lugar/concepto, eso ES un gasto. Registralo.

═══════════════════════════════════════
REGLA #6 — DETECCIÓN DE INTENCIÓN
═══════════════════════════════════════
- SIEMPRE debés devolver el campo "intent" con la intención del usuario.
- Si el usuario dice "eliminá", "borrá", "anulá", "cancelá", "deshacé", "elimina el último gasto" o variaciones → intent = "ANULAR", items vacío, itemToRemove = null.
- Si dice "sacá el pollo", "quitá la coca", "de lo anterior sacá X" → intent = "ANULAR_ITEM", items vacío, itemToRemove = descripción del ítem (ej: "pollo").
- Si menciona "reintegro", "devolución", "me devolvieron" → intent = "REGISTRAR_REEMBOLSO".
- En cualquier otro caso → intent = "REGISTRAR_GASTO".
- Esto aplica tanto para texto como para audio.`;
}

// ---------------------------------------------------------------------------
// 3. Input del servicio
// ---------------------------------------------------------------------------

export type AIExtractionInput = {
  /** Texto plano describiendo el gasto, o caption acompañando la imagen. */
  text?: string;
  /** Buffer de la imagen del ticket (jpg/png). */
  image?: Buffer;
  /** Buffer de audio (voz del usuario, ogg/opus). */
  audio?: Buffer;
};

// ---------------------------------------------------------------------------
// 4. Función principal
// ---------------------------------------------------------------------------

export async function extractTransaction(
  input: AIExtractionInput,
): Promise<ExtractionResult> {
  if (!input.text && !input.image && !input.audio) {
    throw new Error("Debe proporcionarse al menos texto, imagen o audio.");
  }

  const categories = await getCategoryNames();
  const schema = buildExtractionSchema(categories);

  // Arma el contenido multimodal según lo que venga
  const userContent: Array<
    | { type: "text"; text: string }
    | { type: "image"; image: Buffer; mimeType: string }
    | { type: "file"; data: Buffer; mediaType: string }
  > = [];

  if (input.image) {
    userContent.push({
      type: "image",
      image: input.image,
      mimeType: "image/jpeg",
    });
  }

  if (input.audio) {
    userContent.push({
      type: "file",
      data: input.audio,
      mediaType: "audio/ogg",
    });
  }

  if (input.text) {
    userContent.push({
      type: "text",
      text: input.image
        ? `INSTRUCCIÓN DEL USUARIO (tiene prioridad sobre lo que veas en la imagen): ${input.text}`
        : input.text,
    });
  } else if (input.audio && !input.image) {
    userContent.push({
      type: "text",
      text: "El usuario envió un mensaje de voz. Transcribí el audio y determiná la intención: si pide eliminar/borrar/anular un gasto completo → intent ANULAR con items vacío. Si pide sacar/quitar un ítem específico → intent ANULAR_ITEM con itemToRemove = descripción del ítem. Si describe un gasto → intent REGISTRAR_GASTO y extraé los ítems (ej: '10 mil panadería' = $10000 en Panadería). SIEMPRE debe haber al menos un ítem si el intent es REGISTRAR_GASTO.",
    });
  }

  const { output } = await generateText({
    model: google("gemini-2.5-flash"),
    output: Output.object({ schema }),
    messages: [
      { role: "system", content: buildSystemPrompt(categories) },
      { role: "user", content: userContent },
    ],
  });

  if (!output) {
    throw new Error("La IA no pudo generar un objeto válido.");
  }

  return output;
}
