import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { request } from "./request";
import { user } from "./user";

export const requestFile = pgTable(
  "request_file",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => request.id),
    storageKey: text("storage_key").notNull(),
    pageNo: integer("page_no").notNull().default(1),
    mime: text("mime").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    phash: text("phash"),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => user.id),
    thumbnailKey: text("thumbnail_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("request_file_request_id_idx").on(table.requestId),
    index("request_file_sha256_idx").on(table.sha256),
    check("request_file_sha256_length_check", sql`char_length(${table.sha256}) = 64`),
  ],
);
