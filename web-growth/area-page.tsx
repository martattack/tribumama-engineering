import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageShell } from "@/components/PageShell";
import { PageIntro } from "@/components/PageIntro";
import { JsonLd } from "@/components/JsonLd";
import { HowItWorks } from "@/components/home/HowItWorks";
import { FinalInstall } from "@/components/install/FinalInstall";
import type { Locale } from "@/i18n/routing";
import { absoluteUrl, pageMetadata, toLocale } from "@/lib/seo";
import { getSiteStats, type AreaStats } from "@/lib/siteStats";
import { breadcrumbSchema } from "@/lib/structuredData";

type Props = { params: Promise<{ locale: string; area: string }> };

// Areas come from the curated public_areas table, refreshed hourly
export const revalidate = 3600;

const areaName = (area: AreaStats, locale: Locale): string => (locale === "es" ? area.name_es : area.name_en);

// An area with nothing to show yet is still useful to a visitor, but too thin
// to deserve a place in search results
const hasCounts = (area: AreaStats): boolean => area.tribes !== null || area.members !== null;

async function findArea(slug: string): Promise<AreaStats | undefined> {
  const stats = await getSiteStats();
  return stats?.areas.find((area) => area.slug === slug);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale: rawLocale, area: slug } = await params;
  const locale = toLocale(rawLocale);
  const area = await findArea(slug);
  if (!area) return {};
  const t = await getTranslations({ locale, namespace: "areas" });
  const name = areaName(area, locale);
  return pageMetadata({
    locale,
    href: { pathname: "/areas/[area]", params: { area: slug } },
    title: t("title", { area: name }),
    description: t("description", { area: name }),
    noindex: !hasCounts(area),
  });
}

export default async function AreaPage({ params }: Props) {
  const { locale: rawLocale, area: slug } = await params;
  const locale = toLocale(rawLocale);
  setRequestLocale(locale);
  const area = await findArea(slug);
  if (!area) notFound();

  const t = await getTranslations({ locale, namespace: "areas" });
  const name = areaName(area, locale);
  const url = absoluteUrl(locale, { pathname: "/areas/[area]", params: { area: slug } });
  const counts = [
    area.tribes !== null ? t("tribes", { count: area.tribes }) : null,
    area.members !== null ? t("members", { count: area.members }) : null,
  ].filter((item): item is string => item !== null);

  return (
    <PageShell page={`area_${slug}`}>
      <JsonLd
        data={breadcrumbSchema([
          { name: "TribuMama", url: absoluteUrl(locale, "/") },
          { name, url },
        ])}
      />
      <PageIntro heading={t("heading", { area: name })} intro={t("intro", { area: name })} align="center">
        {counts.length > 0 ? (
          <ul className="mt-8 flex flex-wrap justify-center gap-3" role="list">
            {counts.map((item) => (
              <li key={item} className="rounded-full bg-white/10 px-6 py-3 font-extrabold text-white ring-1 ring-white/25">
                {item}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-8 inline-block rounded-full bg-lima px-6 py-3 font-extrabold text-indigo">{t("beFirst", { area: name })}</p>
        )}
        <p className="mt-4 text-xs text-indigo-mist">{t("countsNote")}</p>
      </PageIntro>
      <HowItWorks />
      <FinalInstall page={`area_${slug}`} />
    </PageShell>
  );
}
