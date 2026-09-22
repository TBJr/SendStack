import { config } from "../lib/config";
import { getPool, query } from "../lib/db";
import { hashPassword, makeId, normalizeEmail, utcNow } from "../lib/ids";

async function main() {
  const now = utcNow();
  const adminEmail = normalizeEmail(config.adminEmail);
  const usingDefaultPassword = config.adminPassword === config.defaultAdminPassword;
  const productionLike =
    config.isVercelProduction || (config.nodeEnv === "production" && !config.isVercelPreview);

  if (productionLike && usingDefaultPassword) {
    throw new Error(
      "Refusing to seed the default admin password in production. Set SENDSTACK_ADMIN_PASSWORD to a strong unique value.",
    );
  }

  const existing = await query(`SELECT id FROM users WHERE email = $1`, [adminEmail]);
  if (!existing.rows[0]) {
    await query(
      `INSERT INTO users
         (id, email, name, role, password_hash, active, must_change_password, created_at, updated_at)
       VALUES ($1,$2,$3,'admin',$4,TRUE,$5,$6,$7)`,
      [
        makeId("usr"),
        adminEmail,
        "Test Administrator",
        hashPassword(config.adminPassword),
        usingDefaultPassword,
        now,
        now,
      ],
    );
    console.log(
      `Seeded admin ${adminEmail}` +
        (usingDefaultPassword ? " (must_change_password=true)" : ""),
    );
  } else {
    console.log(`Admin ${adminEmail} already exists`);
  }

  const list = await query(`SELECT id FROM lists WHERE name = $1`, ["Product updates"]);
  let listId: string;
  if (!list.rows[0]) {
    listId = makeId("lst");
    await query(`INSERT INTO lists (id, name, description, created_at) VALUES ($1,$2,$3,$4)`, [
      listId,
      "Product updates",
      "Safe sample audience for the test environment.",
      now,
    ]);
    console.log("Seeded list Product updates");
  } else {
    listId = list.rows[0].id as string;
  }

  const samples = [
    ["alex@example.test", "Alex", "Rivera"],
    ["jordan@example.test", "Jordan", "Lee"],
    ["sam@example.test", "Sam", "Nguyen"],
  ] as const;

  for (const [email, first, last] of samples) {
    const found = await query(`SELECT id FROM contacts WHERE email = $1`, [email]);
    let contactId: string;
    if (!found.rows[0]) {
      contactId = makeId("con");
      await query(
        `INSERT INTO contacts
           (id, email, first_name, last_name, consent_source, consent_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'seed',$5,$6,$7)`,
        [contactId, email, first, last, now, now, now],
      );
    } else {
      contactId = found.rows[0].id as string;
    }
    await query(
      `INSERT INTO list_contacts (list_id, contact_id, added_at)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [listId, contactId, now],
    );
  }

  console.log("Seed complete.");
  await getPool().end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
