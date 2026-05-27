-- CreateTable
CREATE TABLE "highscores" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "wave" INTEGER NOT NULL DEFAULT 1,
    "kill_count" INTEGER NOT NULL DEFAULT 0,
    "kill_summary" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "highscores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "highscores_score_desc" ON "highscores"("score" DESC, "created_at" DESC);
