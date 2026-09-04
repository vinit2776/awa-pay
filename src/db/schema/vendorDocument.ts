import { sql } from "drizzle-orm";
import { bigint, check, date, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { vendorDocumentKindEnum } from "./enums";
import { user } from "./user";
import { vendor } from "./vendor";

// Deliberately its own table, not folded into request_file, despite the
// surface similarity (both are presigned-upload evidence rows with a
// `kind`). request_file's entire RLS shape is built around "this row
// belongs to a request" — a vendor's GST certificate isn't tied to any
// bill, and forcing a second, orthogonal scoping axis onto an
// already-shipped, security-relevant table isn't worth the reuse. Shares
// src/storage's presign/upload machinery (now prefix-parameterized) with
// request_file, not the table itself.
export const vendorDocument = pgTable(
  "vendor_document",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendor.id),
    kind: vendorDocumentKindEnum("kind").notNull(),
    storageKey: text("storage_key").notNull(),
    mime: text("mime").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    expiresOn: date("expires_on"),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("vendor_document_vendor_id_idx").on(table.vendorId),
    check("vendor_document_sha256_length_check", sql`char_length(${table.sha256}) = 64`),
  ],
);
