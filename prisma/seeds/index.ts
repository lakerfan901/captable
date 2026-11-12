import { db } from "@/server/db";
import colors from "colors";
import inquirer from "inquirer";
colors.enable();

import seedCompanies from "./companies";
import seedTeam from "./team";

if (process.env.NODE_ENV === "production") {
  console.log("❌ You cannot run this command on production".red);
  process.exit(0);
}

const seed = async () => {
  const { answer } = await inquirer.prompt<{ answer: boolean }>([
    {
      type: "confirm",
      name: "answer",
      message: "Are you sure you want to NUKE 🚀 and re-seed the database?",
    },
  ]);

  if (answer) {
    await nuke();

    console.log("Seeding database".underline.cyan);
    return db.$transaction(async () => {
      await seedCompanies();
      await seedTeam();
    });
  } else {
    throw new Error("Seeding aborted");
  }
};

const nuke = async () => {
  console.log("🚀 Nuking database records".yellow);
  return db.$transaction(async (db) => {
    await db.user.deleteMany();
    await db.member.deleteMany();
    await db.company.deleteMany();
    await db.shareClass.deleteMany();
    await db.equityPlan.deleteMany();
    await db.document.deleteMany();
    await db.bucket.deleteMany();
    await db.audit.deleteMany();
    await db.session.deleteMany();
  });
};

await seed()
  .then(async () => {
    console.log("✅ Database seeding completed".green);
    console.log(
      `💌 We have created four admin accounts for you. Please login with one of these emails:\n`
        .cyan,
      `ceo@example.com\n`.underline.yellow,
      `cto@example.com\n`.underline.yellow,
      `cfo@example.com\n`.underline.yellow,
      `lawyer@example.com\n`.underline.yellow,
    );
    await db.$disconnect();
  })
  .catch(async (error: Error) => {
    console.log(`❌ ${error.message}`.red);
    await db.$disconnect();
  });
