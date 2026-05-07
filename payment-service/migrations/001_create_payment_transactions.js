exports.up = (pgm) => {
  pgm.createTable("payment_transactions", {
    id: "id",
    order_id: { type: "integer", notNull: true },
    amount: { type: "integer", notNull: true },
    provider: { type: "varchar(50)", notNull: true, default: "VNPAY" },
    transaction_ref: { type: "varchar(255)", notNull: true, unique: true },
    payment_url: { type: "text" },
    status: { type: "varchar(50)", notNull: true, default: "PENDING" },
    provider_response_code: { type: "varchar(20)" },
    provider_transaction_no: { type: "varchar(255)" },
    bank_code: { type: "varchar(50)" },
    raw_response: { type: "jsonb" },
    paid_at: { type: "timestamp" },
    created_at: { type: "timestamp", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamp", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  }, { ifNotExists: true });

  pgm.createIndex("payment_transactions", "order_id", {
    name: "idx_payment_transactions_order_id",
    ifNotExists: true,
  });

  pgm.createIndex("payment_transactions", "transaction_ref", {
    name: "idx_payment_transactions_transaction_ref",
    unique: true,
    ifNotExists: true,
  });
};

exports.down = (pgm) => {
  pgm.dropIndex("payment_transactions", "transaction_ref", {
    name: "idx_payment_transactions_transaction_ref",
    ifExists: true,
  });
  pgm.dropIndex("payment_transactions", "order_id", {
    name: "idx_payment_transactions_order_id",
    ifExists: true,
  });
  pgm.dropTable("payment_transactions", { ifExists: true });
};