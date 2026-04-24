import { prisma } from "../lib/prisma.js";
import type { ExtractionResult } from "./ai.service.js";

// ---------------------------------------------------------------------------
// Tipos de entrada
// ---------------------------------------------------------------------------

export type ProcessInput = {
  intent?: "REGISTRAR_REINTEGRO" | "REGISTRAR_GASTO";
  extraction: ExtractionResult;
  imageUrl?: string;
};

export type CancelResult = {
  type: "receipt" | "transaction";
  description: string;
  itemsAnulados: number;
  totalAnulado: number;
};

// ---------------------------------------------------------------------------
// 1. Resolver helpers
// ---------------------------------------------------------------------------

async function findOrCreateUser(telegramId: string) {
  return prisma.user.upsert({
    where: { telegramId },
    update: {},
    create: { telegramId, name: telegramId },
  });
}

async function resolveCategoryId(categoryName: string): Promise<string> {
  const category = await prisma.category.findUnique({
    where: { name: categoryName },
    select: { id: true },
  });

  if (!category) {
    const fallback = await prisma.category.findUnique({
      where: { name: "Otros" },
      select: { id: true },
    });
    if (!fallback) {
      throw new Error(`Categoría "${categoryName}" no encontrada y no existe "Otros" como fallback.`);
    }
    return fallback.id;
  }

  return category.id;
}

// ---------------------------------------------------------------------------
// 2. processTransactionData
// ---------------------------------------------------------------------------

export async function processTransactionData(
  telegramId: string,
  input: ProcessInput,
): Promise<{ receiptId: string | null; transactionIds: string[] }> {
  const user = await findOrCreateUser(telegramId);
  const { extraction, intent, imageUrl } = input;
  const txType = intent === "REGISTRAR_REINTEGRO" ? "REEMBOLSO" : "EGRESO";

  // Pre-resolver todas las categorías antes de la transacción atómica
  const categoryMap = new Map<string, string>();
  for (const item of extraction.items) {
    if (!categoryMap.has(item.category)) {
      categoryMap.set(item.category, await resolveCategoryId(item.category));
    }
  }

  const totalAmount = extraction.items.reduce((sum, i) => sum + i.amount, 0);
  const hasMerchant = extraction.merchant !== null;
  const isReceipt = hasMerchant || extraction.items.length > 1 || imageUrl;

  // Transacción atómica: crea Receipt (si aplica) + todos los Transaction
  return prisma.$transaction(async (tx) => {
    let receiptId: string | null = null;

    if (isReceipt) {
      const receipt = await tx.receipt.create({
        data: {
          merchant: extraction.merchant,
          totalAmount,
          imageUrl: imageUrl ?? null,
          userId: user.id,
        },
      });
      receiptId = receipt.id;
    }

    const transactionIds: string[] = [];

    for (const item of extraction.items) {
      const created = await tx.transaction.create({
        data: {
          amount: item.amount,
          description: item.description,
          type: txType,
          categoryId: categoryMap.get(item.category)!,
          userId: user.id,
          receiptId,
        },
      });
      transactionIds.push(created.id);
    }

    return { receiptId, transactionIds };
  });
}

// ---------------------------------------------------------------------------
// 3. cancelLastTransaction (Soft Delete)
// ---------------------------------------------------------------------------

export async function cancelLastTransaction(
  telegramId: string,
): Promise<CancelResult> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });

  if (!user) {
    throw new Error("No se encontró el usuario.");
  }

  const lastTx = await prisma.transaction.findFirst({
    where: { userId: user.id, status: "ACTIVO" },
    orderBy: { createdAt: "desc" },
    include: { receipt: true },
  });

  if (!lastTx) {
    throw new Error("No hay transacciones activas para anular.");
  }

  // Caso A: pertenece a un recibo → anular todo el recibo + sus transacciones
  if (lastTx.receiptId && lastTx.receipt) {
    const receiptTxs = await prisma.transaction.findMany({
      where: { receiptId: lastTx.receiptId, status: "ACTIVO" },
      select: { id: true, amount: true, description: true },
    });

    await prisma.$transaction([
      prisma.receipt.update({
        where: { id: lastTx.receiptId },
        data: { status: "ANULADO" },
      }),
      prisma.transaction.updateMany({
        where: { receiptId: lastTx.receiptId, status: "ACTIVO" },
        data: { status: "ANULADO" },
      }),
    ]);

    const totalAnulado = receiptTxs.reduce((sum, t) => sum + t.amount, 0);
    const merchant = lastTx.receipt.merchant ?? "sin comercio";

    return {
      type: "receipt",
      description: `Recibo de ${merchant} (${receiptTxs.length} ítems)`,
      itemsAnulados: receiptTxs.length,
      totalAnulado,
    };
  }

  // Caso B: gasto suelto → anular solo esa transacción
  await prisma.transaction.update({
    where: { id: lastTx.id },
    data: { status: "ANULADO" },
  });

  return {
    type: "transaction",
    description: lastTx.description,
    itemsAnulados: 1,
    totalAnulado: lastTx.amount,
  };
}

// ---------------------------------------------------------------------------
// 4. cancelSpecificItem (Soft Delete de un ítem específico)
// ---------------------------------------------------------------------------

export type CancelItemResult = {
  description: string;
  amount: number;
  remainingItems: number;
};

export async function cancelSpecificItem(
  telegramId: string,
  itemDescription: string,
): Promise<CancelItemResult> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });

  if (!user) {
    throw new Error("No se encontró el usuario.");
  }

  // Buscar las últimas transacciones activas del usuario (últimas 20 para tener margen)
  const recentTxs = await prisma.transaction.findMany({
    where: { userId: user.id, status: "ACTIVO" },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, description: true, amount: true, receiptId: true },
  });

  if (recentTxs.length === 0) {
    throw new Error("No hay transacciones activas.");
  }

  // Buscar el ítem que mejor coincida (búsqueda case-insensitive parcial)
  const needle = itemDescription.toLowerCase();
  const match = recentTxs.find((tx) =>
    tx.description.toLowerCase().includes(needle),
  );

  if (!match) {
    throw new Error(
      `No encontré un ítem que coincida con "${itemDescription}" en tus gastos recientes.`,
    );
  }

  // Anular el ítem
  await prisma.transaction.update({
    where: { id: match.id },
    data: { status: "ANULADO" },
  });

  // Si pertenece a un recibo, actualizar su total
  if (match.receiptId) {
    const remaining = await prisma.transaction.findMany({
      where: { receiptId: match.receiptId, status: "ACTIVO" },
      select: { amount: true },
    });

    const newTotal = remaining.reduce((sum, t) => sum + t.amount, 0);

    if (remaining.length === 0) {
      // No quedan ítems → anular el recibo también
      await prisma.receipt.update({
        where: { id: match.receiptId },
        data: { status: "ANULADO", totalAmount: 0 },
      });
    } else {
      await prisma.receipt.update({
        where: { id: match.receiptId },
        data: { totalAmount: newTotal },
      });
    }

    return {
      description: match.description,
      amount: match.amount,
      remainingItems: remaining.length,
    };
  }

  return {
    description: match.description,
    amount: match.amount,
    remainingItems: 0,
  };
}
