import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});
const prisma = new PrismaClient({ adapter });

const categories = [
  { name: "Hogar/Supermercado", description: "Compras de almacén, limpieza y artículos del hogar" },
  { name: "Servicios y Suscripciones", description: "Luz, gas, agua, internet, telefonía, streaming y suscripciones" },
  { name: "Salud y Bienestar", description: "Farmacia, consultas médicas, obra social y gimnasio" },
  { name: "Mascotas", description: "Alimento, veterinaria y accesorios para mascotas" },
  { name: "Delivery", description: "Pedidos de comida y bebida por apps de delivery (PedidosYa, Rappi, etc.)" },
  { name: "Salidas y Ocio", description: "Restaurantes, bares, cine y entretenimiento presencial" },
  { name: "Transporte", description: "Combustible, peajes, estacionamiento y transporte público" },
  { name: "Indumentaria", description: "Ropa, calzado y accesorios personales" },
  { name: "Vivienda y Alquiler", description: "Alquiler, expensas y gastos fijos de vivienda" },
  { name: "Ahorro e Inversiones", description: "Compra de dólares, transferencias a cuentas de inversión y ahorro" },
  { name: "Mantenimiento y Arreglos", description: "Ferretería, repuestos, arreglos del hogar y mecánicos" },
  { name: "Otros", description: "Gastos que no encajan en otra categoría" },
];

async function main() {
  console.log("Seeding categories...");

  for (const cat of categories) {
    await prisma.category.upsert({
      where: { name: cat.name },
      update: {},
      create: cat,
    });
  }

  console.log(`Seeded ${categories.length} categories.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
