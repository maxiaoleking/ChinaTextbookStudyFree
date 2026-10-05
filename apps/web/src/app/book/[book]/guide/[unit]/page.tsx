import { promises as fs } from "fs";
import path from "path";
import { notFound } from "next/navigation";
import type { SiteIndex } from "@/types";
import type { KnowledgeSummary, Outline } from "@cstf/core";
import { GuideClient } from "./GuideClient";

async function getIndex(): Promise<SiteIndex> {
  const p = path.join(process.cwd(), "public", "data", "index.json");
  return JSON.parse(await fs.readFile(p, "utf-8"));
}

interface OutlineWithLessons extends Outline {
  lessons: { id: string; unitNumber: number }[];
}

async function getOutline(bookId: string): Promise<OutlineWithLessons> {
  const p = path.join(process.cwd(), "public", "data", "books", bookId, "outline.json");
  return JSON.parse(await fs.readFile(p, "utf-8"));
}

async function getUnitSummaries(
  bookId: string,
  unitNum: number,
  outline: OutlineWithLessons,
): Promise<KnowledgeSummary[]> {
  const out: KnowledgeSummary[] = [];
  for (const meta of outline.lessons.filter(lesson => lesson.unitNumber === unitNum)) {
    const lessonPath = path.join(
      process.cwd(),
      "public",
      "data",
      "books",
      bookId,
      "lessons",
      `${meta.id}.json`,
    );
    try {
      const lesson = JSON.parse(await fs.readFile(lessonPath, "utf-8"));
      if (lesson?.knowledge) out.push(lesson.knowledge as KnowledgeSummary);
    } catch {
      // 课程文件缺失时跳过：最终交给客户端显示空态
    }
  }
  return out;
}

export async function generateStaticParams() {
  const index = await getIndex();
  const params: { book: string; unit: string }[] = [];
  for (const b of index.books) {
    try {
      const outline = await getOutline(b.id);
      for (const u of outline.units) {
        params.push({ book: b.id, unit: String(u.unit_number) });
      }
    } catch {
      // 某本书 outline 缺失时跳过
    }
  }
  return params;
}

export default async function GuidePage({
  params,
}: {
  params: Promise<{ book: string; unit: string }>;
}) {
  const { book: bookId, unit: unitParam } = await params;
  const index = await getIndex();
  const book = index.books.find(b => b.id === bookId);
  if (!book) notFound();
  const outline = await getOutline(bookId);
  const unitNum = Number(unitParam);
  const unit = outline.units.find(u => u.unit_number === unitNum);
  if (!unit) notFound();

  const summaries = await getUnitSummaries(bookId, unitNum, outline);

  return <GuideClient book={book} unit={unit} summaries={summaries} />;
}
