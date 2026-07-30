-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "google_sub" TEXT NOT NULL,
    "email" TEXT,
    "display_name" TEXT,
    "picture" TEXT,
    "username" TEXT,
    "username_lower" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMPTZ,
    "games_played" INTEGER NOT NULL DEFAULT 0,
    "best_score" INTEGER NOT NULL DEFAULT 0,
    "best_wave" INTEGER NOT NULL DEFAULT 0,
    "best_combo" INTEGER NOT NULL DEFAULT 0,
    "total_kills" INTEGER NOT NULL DEFAULT 0,
    "total_score" BIGINT NOT NULL DEFAULT 0,
    "last_played_at" TIMESTAMPTZ,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_google_sub_key" ON "users"("google_sub");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_lower_key" ON "users"("username_lower");

-- AlterTable
ALTER TABLE "highscores" ADD COLUMN "user_id" INTEGER;

-- CreateIndex
CREATE INDEX "highscores_user_id" ON "highscores"("user_id");

-- AddForeignKey
ALTER TABLE "highscores" ADD CONSTRAINT "highscores_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
