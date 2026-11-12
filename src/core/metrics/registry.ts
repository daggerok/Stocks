/// <reference lib="esnext" />
/**
 * The metric registry: one entry for every key of `metrics` in the Stocks feed and the 29 ETF brand feeds, the screener's
 * row fields and, with `source: 'planned'`, any metric a preset references before the updater publishes it (none at the moment).
 * Formulas follow scripts/update-data.ts (Stocks) and the brand updaters (ETFs). Families (growth, margins, performance
 * windows, issuer text companions) are generated from small tables so every entry gets a full name, short text and guide
 */
import type { AssetType, Basis, Direction, MetricDef, Source, Text, Unit } from './types';

export const REGISTRY_SCHEMA_VERSION = 1;

const STOCK: AssetType[] = ['stock'];
const ETF: AssetType[] = ['etf'];
const BOTH: AssetType[] = ['stock', 'etf'];

const ADR_NULL: Text = {
  en: 'the multiple is not positive, Yahoo has no value, or the price currency differs from the reporting currency (ADRs)',
  ru: 'мультипликатор не положителен, у Yahoo нет значения или валюта цены отличается от валюты отчётности (ADR)',
};
/** pe, ps, pFcf, pb, enterpriseValue of a foreign issuer (plan 1.3): market cap over its SEC amounts in USD */
const FOREIGN_NULL: Text = {
  en: 'the multiple is not positive or Yahoo has no value; a foreign issuer (20-F or 40-F, or amounts in another currency) instead takes market cap over its SEC amount converted to USD, empty without a fresh SEC layer',
  ru: 'мультипликатор не положителен или у Yahoo нет значения; у иностранного эмитента (20-F или 40-F либо суммы в другой валюте) вместо этого берётся капитализация к сумме из SEC в USD, без свежего слоя SEC пусто',
};
/** pe, ps, pFcf, pb and evEbitda (owner answer N29): no multiple over an annual-only TTM older than 12 months */
const STALE_TTM_NULL: Text = {
  en: 'the TTM is the last fiscal year of an issuer without quarterly XBRL (ttmIsAnnual) and ended more than 12 months before the last close',
  ru: 'TTM - последний финансовый год эмитента без квартального XBRL (ttmIsAnnual), и он закончился больше 12 месяцев назад',
};
const MULTIPLE_NULL: Text = { en: `${FOREIGN_NULL.en}; also empty when ${STALE_TTM_NULL.en}`, ru: `${FOREIGN_NULL.ru}; также пусто, когда ${STALE_TTM_NULL.ru}` };
const FIN_NOTE: Text = {
  en: 'Banks and insurers have no meaningful EBITDA, current ratio or free cash flow; compare them on P/B and ROE-type measures instead',
  ru: 'У банков и страховых EBITDA, текущая ликвидность и свободный денежный поток не имеют смысла: их сравнивают по P/B и доходности капитала',
};

type Spec = Omit<MetricDef, 'appliesTo'> & { appliesTo?: AssetType[] };
const def = (spec: Spec): MetricDef => ({ ...spec, appliesTo: spec.appliesTo ?? STOCK });

// ---------------------------------------------------------------------------
// market data (Yahoo)

const MARKET: MetricDef[] = [
  def({
    id: 'marketCap', name: { en: 'Market cap', ru: 'Капитализация' }, formula: 'price × shares outstanding (Yahoo quoteSummary)',
    unit: 'usd', basis: 'snapshot', source: 'yahoo-summary', direction: 'neutral',
    short: { en: 'Market value of all shares in USD', ru: 'Рыночная стоимость всех акций в USD' },
    guide: {
      en: 'Market capitalization is the price times the shares outstanding, taken from the Yahoo quoteSummary snapshot. It sizes the company: below $2B is small cap, $2B to $10B mid cap, above $10B large cap. Small caps move more and trade thinner, so presets often set a floor such as $2B. Share classes (GOOG and GOOGL) carry the cap of the whole company',
      ru: 'Капитализация - цена, умноженная на число акций в обращении, из снимка Yahoo quoteSummary. Она задаёт размер компании: до $2 млрд - малая, от $2 до $10 млрд - средняя, выше $10 млрд - крупная. Малые компании колеблются сильнее и торгуются тоньше, поэтому пресеты часто ставят нижнюю границу, например $2 млрд. Классы акций (GOOG и GOOGL) несут капитализацию всей компании',
    },
  }),
  def({
    id: 'enterpriseValue', name: { en: 'Enterprise value', ru: 'Стоимость компании (EV)' }, formula: 'market cap + debt - cash (Yahoo quoteSummary enterpriseValue); foreign issuers: market cap + debt + minority interest + preferred - cash - short-term investments of the SEC layer in USD',
    unit: 'usd', basis: 'snapshot', source: 'yahoo-summary', direction: 'neutral', nullWhen: FOREIGN_NULL,
    short: { en: 'Price of the whole business: equity plus net debt', ru: 'Цена всего бизнеса: капитал плюс чистый долг' },
    guide: {
      en: 'Enterprise value is what a buyer would pay for the whole business: market cap plus debt minus cash, as reported by Yahoo. Unlike market cap it does not reward a company for borrowing, so it is the numerator of EV/EBITDA. A value far above market cap means heavy debt; below it means a cash pile',
      ru: 'EV - сколько покупатель заплатил бы за весь бизнес: капитализация плюс долг минус кэш, по данным Yahoo. В отличие от капитализации EV не поощряет компанию за долг, поэтому стоит в числителе EV/EBITDA. EV намного выше капитализации означает большой долг, ниже - запас кэша',
    },
  }),
  def({
    id: 'price', name: { en: 'Price', ru: 'Цена' }, formula: 'last daily close, unadjusted (Yahoo chart)',
    unit: 'usd', basis: 'price', source: 'yahoo-chart', direction: 'neutral',
    short: { en: 'Last close in USD', ru: 'Последнее закрытие в USD' },
    guide: {
      en: 'The last daily close of the Yahoo chart, not adjusted for dividends, as of performanceAsOf. A price alone says nothing about value; read it together with the multiples and the 52-week range. During a trading session the last candle can be partial',
      ru: 'Последнее дневное закрытие из графика Yahoo без поправки на дивиденды, на дату performanceAsOf. Сама по себе цена ничего не говорит о стоимости: её читают вместе с мультипликаторами и годовым диапазоном. Во время торговой сессии последняя свеча может быть неполной',
    },
  }),
  def({
    id: 'week52High', name: { en: '52-week high', ru: 'Максимум за 52 недели' }, formula: 'stocks: Yahoo fiftyTwoWeekHigh (intraday), else the highest close of 52 weeks; ETFs: highest published close of 52 weeks',
    unit: 'usd', basis: 'price', source: 'yahoo-summary', direction: 'neutral', appliesTo: BOTH,
    short: { en: 'Highest price of the last 52 weeks', ru: 'Самая высокая цена за 52 недели' },
    guide: {
      en: 'The top of the one-year range. Stocks take the intraday high from the Yahoo snapshot and fall back to the highest close of the chart when the snapshot fails; ETFs use the highest close of their published history (a fund younger than a year uses its history since launch, see range52wSince). A price near the high is strength or an exit zone for a swing trader',
      ru: 'Верх годового диапазона. У акций - внутридневной максимум из снимка Yahoo, при сбое снимка - самое высокое закрытие графика; у ETF - самое высокое закрытие опубликованной истории (у фонда моложе года - с даты запуска, см. range52wSince). Цена у максимума - сила тренда или зона продажи для свинга',
    },
  }),
  def({
    id: 'week52Low', name: { en: '52-week low', ru: 'Минимум за 52 недели' }, formula: 'stocks: Yahoo fiftyTwoWeekLow (intraday), else the lowest close of 52 weeks; ETFs: lowest published close of 52 weeks',
    unit: 'usd', basis: 'price', source: 'yahoo-summary', direction: 'neutral', appliesTo: BOTH,
    short: { en: 'Lowest price of the last 52 weeks', ru: 'Самая низкая цена за 52 недели' },
    guide: {
      en: 'The bottom of the one-year range, from the same sources as the 52-week high. A price near the low can be a buying zone for a stock with intact fundamentals or a warning for one whose business is deteriorating, so pair it with quality metrics',
      ru: 'Низ годового диапазона, из тех же источников, что и максимум. Цена у минимума может быть зоной покупки для бумаги с крепким бизнесом или предупреждением для бумаги, у которой бизнес портится, поэтому её сочетают с метриками качества',
    },
  }),
  def({
    id: 'range52w', name: { en: '52-week range position', ru: 'Положение в годовом диапазоне' }, formula: '(last close - 52w low) / (52w high - 52w low) × 100, clamped to 0..100',
    unit: 'percent', basis: 'price', source: 'computed', direction: 'neutral', appliesTo: BOTH, thresholds: { good: 25 },
    nullWhen: { en: 'a value is missing or the high is not above the low', ru: 'нет одного из значений или максимум не выше минимума' },
    short: { en: 'Where the price sits in its 1-year range: 0 at the low, 100 at the high', ru: 'Где цена в годовом диапазоне: 0 у минимума, 100 у максимума' },
    guide: {
      en: 'Position of the last close between the 52-week low and high: 0 means at the low, 100 at the high, two decimals. Buy-low investors look below 25, profit takers above 85. Stocks use Yahoo intraday extremes, so a close slightly outside is clamped; ETFs use closes only. A flat window gives an empty value, never a made-up 50',
      ru: 'Положение последнего закрытия между минимумом и максимумом за 52 недели: 0 - у минимума, 100 - у максимума, два знака. Кто добирает ниже, смотрит значения до 25, кто фиксирует прибыль - выше 85. У акций экстремумы внутридневные из Yahoo, поэтому закрытие чуть за границей прижимается к 0 или 100; у ETF берутся только закрытия. Ровный диапазон даёт пустое значение, а не выдуманные 50',
    },
  }),
  def({
    id: 'beta', name: { en: 'Beta', ru: 'Бета' }, formula: 'Yahoo beta: sensitivity of monthly returns to the S&P 500 over 5 years',
    unit: 'ratio', basis: 'snapshot', source: 'yahoo-summary', direction: 'neutral', thresholds: { good: 1 },
    short: { en: 'How strongly the stock moves with the market', ru: 'Насколько сильно бумага движется вместе с рынком' },
    guide: {
      en: 'Beta measures how much the stock moved with the S&P 500 over the last five years of monthly returns (Yahoo). 1 moves with the market, below 1 is calmer, above 1.5 amplifies swings, a negative beta moves against it. Stable dividend payers usually sit below 1. Beta is backward looking and says nothing about company-specific risk',
      ru: 'Бета показывает, насколько бумага двигалась вместе с S&P 500 по месячным доходностям за пять лет (Yahoo). 1 - движется как рынок, ниже 1 - спокойнее, выше 1,5 - усиливает колебания, отрицательная - движется против рынка. У стабильных дивидендных бумаг бета обычно ниже 1. Бета смотрит в прошлое и не учитывает риски самой компании',
    },
  }),
  def({
    id: 'sharesOutstanding', name: { en: 'Shares outstanding', ru: 'Акций в обращении' }, formula: 'Yahoo defaultKeyStatistics.sharesOutstanding',
    unit: 'count', basis: 'snapshot', source: 'yahoo-summary', direction: 'neutral',
    short: { en: 'Number of shares in circulation', ru: 'Число акций в обращении' },
    guide: {
      en: 'The number of shares in circulation from the Yahoo snapshot. On its own it is a scale figure; its change over time matters more: a falling count means buybacks that lift EPS, a rising one means dilution from stock compensation or issuance',
      ru: 'Число акций в обращении из снимка Yahoo. Само по себе это просто масштаб, важнее динамика: сокращение означает выкупы, которые поднимают EPS, рост - размытие за счёт выплат акциями сотрудникам или допэмиссий',
    },
  }),
];

// ---------------------------------------------------------------------------
// valuation (Yahoo quoteSummary TTM and forward snapshot)

const VALUATION: MetricDef[] = [
  def({
    id: 'pe', name: { en: 'P/E (TTM)', ru: 'P/E (TTM)' }, formula: 'price / diluted EPS of the trailing twelve months (Yahoo trailingPE); foreign issuers: market cap / TTM net income of the SEC layer in USD',
    unit: 'ratio', basis: 'ttm', source: 'yahoo-summary', direction: 'lower-is-better', thresholds: { good: 15, bad: 30 }, nullWhen: { en: 'the company has a loss (EPS not positive) or ' + MULTIPLE_NULL.en, ru: 'у компании убыток (EPS не положителен) или ' + MULTIPLE_NULL.ru },
    sectorNotes: { en: 'Cyclicals look cheapest at the peak of profits; fast growers carry high P/E for years', ru: 'Циклические компании выглядят дешевле всего на пике прибыли, у быстрорастущих P/E годами высокий' },
    short: { en: 'Years of current earnings the price pays for', ru: 'Сколько лет текущей прибыли стоит цена' },
    guide: {
      en: 'P/E divides the price by the diluted earnings per share of the last twelve months, taken from the Yahoo snapshot. 10 to 15 is cheap for a mature business, 25 and more prices in growth. A loss leaves it empty, never negative. Compare P/E within a sector or against the company\'s own history: a bank at 10 and a software company at 30 can be equally fair',
      ru: 'P/E делит цену на разводнённую прибыль на акцию за последние двенадцать месяцев, из снимка Yahoo. 10-15 - дёшево для зрелого бизнеса, от 25 - в цене уже заложен рост. При убытке метрика пустая, а не отрицательная. P/E сравнивают внутри сектора или с собственной историей компании: банк с P/E 10 и софтверная компания с 30 могут быть оценены одинаково честно',
    },
  }),
  def({
    id: 'forwardPe', name: { en: 'Forward P/E', ru: 'Форвардный P/E' }, formula: 'price / consensus EPS of the next fiscal year (Yahoo forwardPE)',
    unit: 'ratio', basis: 'forward', source: 'yahoo-summary', direction: 'lower-is-better', thresholds: { good: 15, bad: 30 }, nullWhen: ADR_NULL,
    short: { en: 'Price over next year\'s expected earnings', ru: 'Цена к ожидаемой прибыли следующего года' },
    guide: {
      en: 'Forward P/E divides the price by the analysts\' consensus EPS for the next fiscal year (Yahoo). Below the TTM P/E means earnings are expected to grow, above it means a decline. It depends on forecasts that are revised often, so read it next to the TTM P/E. The cheap-earnings preset compares it with the market, sector and peers as percentiles',
      ru: 'Форвардный P/E делит цену на консенсус-прогноз EPS аналитиков на следующий финансовый год (Yahoo). Ниже P/E TTM - ждут роста прибыли, выше - снижения. Он зависит от прогнозов, которые часто пересматривают, поэтому его читают рядом с P/E TTM. Пресет «Дёшево по прибыли» сравнивает его с рынком, сектором и пирами через перцентили',
    },
  }),
  def({
    id: 'ps', name: { en: 'P/S (TTM)', ru: 'P/S (TTM)' }, formula: 'market cap / revenue of the trailing twelve months (Yahoo priceToSalesTrailing12Months); foreign issuers: over the SEC TTM revenue in USD',
    unit: 'ratio', basis: 'ttm', source: 'yahoo-summary', direction: 'lower-is-better', thresholds: { good: 2, bad: 10 }, nullWhen: MULTIPLE_NULL,
    short: { en: 'Price over a year of sales', ru: 'Цена к годовой выручке' },
    guide: {
      en: 'P/S divides the market cap by the revenue of the last twelve months. It works for companies without profits, where P/E is empty, which makes it the main yardstick for growth stocks. Low-margin businesses (retail, distributors) trade below 1, high-margin software at 10 and more, so compare within a sector',
      ru: 'P/S делит капитализацию на выручку за последние двенадцать месяцев. Он работает и для компаний без прибыли, где P/E пуст, поэтому это главный ориентир для растущих бумаг. Низкомаржинальный бизнес (ритейл, дистрибуция) торгуется ниже 1, высокомаржинальный софт - от 10, поэтому сравнивают внутри сектора',
    },
  }),
  def({
    id: 'forwardPs', name: { en: 'Forward P/S', ru: 'Форвардный P/S' }, formula: 'market cap / consensus revenue of the next fiscal year (Yahoo earningsTrend +1y)',
    unit: 'ratio', basis: 'forward', source: 'computed', direction: 'lower-is-better', nullWhen: { en: 'no positive revenue consensus or ' + ADR_NULL.en, ru: 'нет положительного консенсуса по выручке или ' + ADR_NULL.ru },
    short: { en: 'Price over next year\'s expected sales', ru: 'Цена к ожидаемой выручке следующего года' },
    guide: {
      en: 'Forward P/S divides the market cap by the analysts\' revenue consensus for the next fiscal year from Yahoo earningsTrend. A forward P/S well below the TTM P/S means fast expected growth. Useful for unprofitable growers; forecasts are often too optimistic for young companies',
      ru: 'Форвардный P/S делит капитализацию на консенсус-прогноз выручки на следующий финансовый год из Yahoo earningsTrend. Если он заметно ниже P/S TTM, ждут быстрого роста. Полезен для растущих компаний без прибыли; у молодых компаний прогнозы часто слишком оптимистичны',
    },
  }),
  def({
    id: 'pFcf', name: { en: 'P/FCF', ru: 'P/FCF' }, formula: 'market cap / free cash flow of the trailing twelve months (Yahoo financialData.freeCashflow); foreign issuers: over SEC TTM CFO - capex in USD',
    unit: 'ratio', basis: 'ttm', source: 'computed', direction: 'lower-is-better', thresholds: { good: 15, bad: 30 }, nullWhen: { en: 'free cash flow is not positive or ' + MULTIPLE_NULL.en, ru: 'свободный денежный поток не положителен или ' + MULTIPLE_NULL.ru }, sectorNotes: FIN_NOTE,
    short: { en: 'Price over a year of free cash flow', ru: 'Цена к годовому свободному денежному потоку' },
    guide: {
      en: 'P/FCF divides the market cap by the free cash flow of the last twelve months (Yahoo). Cash is harder to dress up than earnings, so a low P/FCF next to a high P/E often means accounting charges, and the reverse means heavy investment. Below 15 is cheap, above 30 expensive for a mature company. Empty when FCF is zero or negative',
      ru: 'P/FCF делит капитализацию на свободный денежный поток за последние двенадцать месяцев (Yahoo). Деньги труднее приукрасить, чем прибыль, поэтому низкий P/FCF при высоком P/E часто означает бумажные списания, а обратная картина - большие инвестиции. Ниже 15 - дёшево, выше 30 - дорого для зрелой компании. Пусто при нулевом или отрицательном FCF',
    },
  }),
  def({
    id: 'evEbitda', name: { en: 'EV/EBITDA', ru: 'EV/EBITDA' }, formula: 'EV / EBITDA TTM; EV = market cap + debt + minority interest + preferred stock - cash - short-term investments (balance of the last quarter), EBITDA = operating income + D&A, TTM (SEC 10-K and 10-Q)',
    unit: 'ratio', basis: 'ttm', source: 'computed', direction: 'lower-is-better', thresholds: { good: 10, bad: 20 }, nullWhen: { en: `EBITDA or EV is zero or negative, or cash, operating income or D&A is not tagged, or debt is not tagged at the last quarter of an issuer that reported debt in the last 3 years (one without any debt line counts 0), or ${STALE_TTM_NULL.en}`, ru: `EBITDA или EV нулевые или отрицательные, либо не размечены кэш, операционная прибыль или амортизация, либо долг не размечен на последний квартал у эмитента, отражавшего долг в последние 3 года (у эмитента без строк долга он равен 0), либо ${STALE_TTM_NULL.ru}` }, sectorNotes: { en: `${FIN_NOTE.en}. Empty for banks and insurers`, ru: `${FIN_NOTE.ru}. У банков и страховых пусто` },
    short: { en: 'Business price over operating cash earnings', ru: 'Цена бизнеса к операционной прибыли до амортизации' },
    guide: {
      en: 'EV/EBITDA compares the price of the whole business, debt included, with its earnings before interest, taxes, depreciation and amortization. It is neutral to capital structure, so it compares companies with different debt better than P/E. Below 10 is usually cheap, above 20 expensive. Since the quarterly SEC layer (plan 1.5) both parts are the updater\'s own: EBITDA is operating income plus depreciation and amortization of the trailing twelve months, EV is the market cap plus debt, minority interest and preferred stock minus cash and short-term investments of the last quarter (before, the value was Yahoo\'s enterpriseToEbitda). A company that has tagged no debt line for 3 years (Arista, Monolithic Power) counts debt 0, so a debt-free company has a value; a REIT without operating income still has none',
      ru: 'EV/EBITDA сравнивает цену всего бизнеса вместе с долгом с прибылью до процентов, налогов и амортизации. Метрика не зависит от структуры капитала и поэтому лучше P/E сравнивает компании с разным долгом. Ниже 10 обычно дёшево, выше 20 - дорого. С квартальным слоем SEC (план 1.5) обе части считает сам апдейтер: EBITDA - операционная прибыль плюс амортизация за последние двенадцать месяцев, EV - капитализация плюс долг, доля меньшинства и привилегированные акции минус кэш и краткосрочные вложения последнего квартала (раньше бралось enterpriseToEbitda из Yahoo). Компания, которая 3 года не размечает ни одной строки долга (Arista, Monolithic Power), считается без долга (долг 0), поэтому у неё есть значение; у REIT без операционной прибыли его по-прежнему нет',
    },
  }),
  def({
    id: 'fcfToEbitda', name: { en: 'FCF / EBITDA', ru: 'FCF / EBITDA' }, formula: '(operating cash flow - capex) / (operating income + D&A) × 100, both TTM (SEC 10-K and 10-Q)',
    unit: 'percent', basis: 'ttm', source: 'sec', direction: 'higher-is-better', thresholds: { good: 60 }, nullWhen: { en: 'EBITDA is not positive or a value is missing', ru: 'EBITDA не положительна или нет одного из значений' }, sectorNotes: { en: `${FIN_NOTE.en}. Empty for banks and insurers`, ru: `${FIN_NOTE.ru}. У банков и страховых пусто` },
    short: { en: 'Share of EBITDA that turns into free cash', ru: 'Какая доля EBITDA превращается в свободные деньги' },
    guide: {
      en: 'Cash conversion: how much of EBITDA is left as free cash flow after interest, taxes, working capital and capital spending. Above 60% is a cash machine, below 30% means heavy investment or high interest. A negative value means the company burns cash despite positive EBITDA. Both are the updater\'s own TTM values from the SEC filings since the quarterly layer (plan 1.5); before, both came from Yahoo',
      ru: 'Конверсия в деньги: сколько EBITDA остаётся свободным денежным потоком после процентов, налогов, оборотного капитала и капзатрат. Выше 60% - денежная машина, ниже 30% - большие инвестиции или высокие проценты. Отрицательное значение означает, что компания сжигает деньги при положительной EBITDA. С квартальным слоем (план 1.5) оба значения - собственные TTM апдейтера по отчётности SEC; раньше оба брались из Yahoo',
    },
  }),
  def({
    id: 'pb', name: { en: 'P/B', ru: 'P/B' }, formula: 'price / book value per share (Yahoo priceToBook); foreign issuers: market cap / SEC equity in USD',
    unit: 'ratio', basis: 'snapshot', source: 'yahoo-summary', direction: 'lower-is-better', thresholds: { good: 1.5, bad: 5 }, nullWhen: { en: 'book value is not positive or ' + MULTIPLE_NULL.en, ru: 'балансовый капитал не положителен или ' + MULTIPLE_NULL.ru },
    sectorNotes: { en: 'Central for banks and insurers; weak for asset-light companies whose value is in brands and software', ru: 'Главный мультипликатор для банков и страховых; слабый для компаний, чья ценность в брендах и софте, а не в активах' },
    short: { en: 'Price over book equity', ru: 'Цена к балансовому капиталу' },
    guide: {
      en: 'P/B divides the price by the book value of equity per share. Below 1 the market values the company below its net assets, which is a value signal for banks and insurers and often a warning elsewhere. Buybacks shrink book value, so asset-light companies can show very high or empty P/B',
      ru: 'P/B делит цену на балансовую стоимость капитала на акцию. Ниже 1 рынок оценивает компанию дешевле её чистых активов: для банков и страховых это сигнал недооценки, для остальных часто предупреждение. Выкупы уменьшают капитал, поэтому у компаний без тяжёлых активов P/B бывает очень высоким или пустым',
    },
  }),
];

// ---------------------------------------------------------------------------
// dividends

const DIVIDENDS: MetricDef[] = [
  def({
    id: 'dividendYield', name: { en: 'Dividend yield', ru: 'Дивидендная доходность' }, formula: 'stocks: dividends with ex-dates in the last 12 months / last close × 100; ETFs: the issuer\'s headline yield (definition in dividendYieldBasis)',
    unit: 'percent', basis: 'ttm', source: 'yahoo-chart', direction: 'higher-is-better', appliesTo: BOTH, thresholds: { good: 2 },
    nullWhen: { en: 'there is no price (stocks) or the issuer publishes no yield (ETFs); a stock without payments in 12 months honestly shows 0', ru: 'нет цены (акции) или эмитент не публикует доходность (ETF); акция без выплат за 12 месяцев честно показывает 0' },
    short: { en: 'Yearly cash payout as a percent of the price', ru: 'Годовые выплаты в процентах от цены' },
    guide: {
      en: 'For a stock: the dividends with ex-dates in the last 12 months divided by the last close, from the Yahoo chart; 0 means no payment in a year. For an ETF: the issuer\'s headline yield, whose definition (trailing 12 months, distribution rate, indicated) is in dividendYieldBasis. 2-4% is typical for stable payers; a yield far above the sector often means the market expects a cut',
      ru: 'У акции: дивиденды с экс-датой за последние 12 месяцев, делённые на последнее закрытие, по графику Yahoo; 0 - выплат за год не было. У ETF: основная доходность эмитента, её определение (за 12 месяцев, ставка распределения, расчётная) записано в dividendYieldBasis. Для стабильных плательщиков типично 2-4%; доходность намного выше сектора часто значит, что рынок ждёт сокращения выплат',
    },
  }),
  def({
    id: 'dividendRate', name: { en: 'Dividend per share (12M)', ru: 'Дивиденд на акцию (12 мес.)' }, formula: 'sum of dividends per share with ex-dates in the last 12 months (Yahoo chart)',
    unit: 'usd', basis: 'ttm', source: 'yahoo-chart', direction: 'neutral', nullWhen: { en: 'no payment in the last 12 months', ru: 'выплат за последние 12 месяцев не было' },
    short: { en: 'Dollars paid per share over the last year', ru: 'Сколько долларов выплачено на акцию за год' },
    guide: {
      en: 'The sum of the dividends per share with ex-dates in the last 12 months, split adjusted, in the price currency. It is the numerator of the dividend yield. A special dividend inflates it for one year, so check the Dividends tab before trusting a jump',
      ru: 'Сумма дивидендов на акцию с экс-датой за последние 12 месяцев с поправкой на сплиты, в валюте цены. Это числитель дивидендной доходности. Специальный дивиденд раздувает её на один год, поэтому перед выводами о скачке смотрят вкладку Dividends',
    },
  }),
  ...([[1, '', '1 year', '1 год', 'the last complete calendar year over the year before'], [3, '3y', '3 years', '3 года', 'CAGR of the last complete calendar year over 3 years earlier'], [5, '5y', '5 years', '5 лет', 'CAGR of the last complete calendar year over 5 years earlier']] as Array<[number, string, string, string, string]>).map(([n, suffix, en, ru, formula]) => def({
    id: `dividendGrowth${suffix}`, name: { en: `Dividend growth ${en}`, ru: `Рост дивиденда за ${ru}` }, formula: `${formula}, sums of split-adjusted dividends per share by calendar year (Yahoo chart)`,
    unit: 'percent', basis: 'calendar-year', source: 'yahoo-chart', direction: 'higher-is-better', thresholds: n === 5 ? { good: 5 } : undefined,
    nullWhen: { en: 'the base year has no dividend or the history is too short', ru: 'в базовом году не было дивиденда или история слишком короткая' },
    short: { en: n === 1 ? 'Change of the yearly dividend versus the previous year' : `Average yearly dividend growth over ${en}`, ru: n === 1 ? 'Изменение годового дивиденда к прошлому году' : `Средний годовой рост дивиденда за ${ru}` },
    guide: {
      en: `Dividend per share summed by calendar year from the Yahoo chart, split adjusted; the current year is partial, so the last complete year is compared ${n === 1 ? 'with the year before' : `with ${n} years earlier as a compound annual rate`}. Dividend growers raise payouts 5-10% a year; growth above earnings growth cannot last. A special dividend or a payment moved between years can fake a jump or a cut, so confirm in the Dividends tab`,
      ru: `Дивиденд на акцию, суммированный по календарным годам из графика Yahoo, с поправкой на сплиты; текущий год неполный, поэтому последний полный год сравнивается ${n === 1 ? 'с предыдущим' : `с годом ${n} года назад как среднегодовой темп`}. Компании с растущим дивидендом поднимают выплаты на 5-10% в год; рост быстрее прибыли долго не продержится. Спецдивиденд или выплата, сдвинутая между годами, может дать ложный скачок или ложное сокращение, поэтому проверяют вкладку Dividends`.replace('с годом 3 года назад', 'с годом три года назад').replace('с годом 5 года назад', 'с годом пять лет назад'),
    },
  })),
  def({
    id: 'payoutRatio', name: { en: 'Payout ratio', ru: 'Доля прибыли на дивиденды' }, formula: 'dividends paid / net income × 100, latest fiscal year (SEC 10-K)',
    unit: 'percent', basis: 'fy', source: 'sec', direction: 'lower-is-better', thresholds: { good: 60, bad: 90 },
    nullWhen: { en: 'net income is zero or negative, or no dividends are reported', ru: 'чистая прибыль нулевая или отрицательная либо дивиденды не отражены' },
    sectorNotes: { en: 'REITs and MLPs pay out most of their cash by design and look over 100% on net income; ffoPayoutApprox (payout of the approximate FFO) replaces it for REITs', ru: 'REIT и MLP по устройству раздают почти все деньги и на чистой прибыли выглядят выше 100%; для REIT его заменяет ffoPayoutApprox (payout от приблизительного FFO)' },
    short: { en: 'Share of profit paid as dividends', ru: 'Какая доля прибыли уходит на дивиденды' },
    guide: {
      en: 'Dividends paid divided by net income of the latest fiscal year from the 10-K cash flow statement. Below 60% leaves room to grow the dividend, above 90% means the dividend depends on profits not falling. A loss leaves it empty rather than negative; then look at the FCF payout',
      ru: 'Выплаченные дивиденды, делённые на чистую прибыль последнего финансового года по отчёту о движении денег из 10-K. Ниже 60% - есть запас для роста дивиденда, выше 90% - дивиденд держится, только пока прибыль не падает. При убытке метрика пуста, а не отрицательна; тогда смотрят FCF payout',
    },
  }),
  def({
    id: 'fcfPayout', name: { en: 'FCF payout', ru: 'Доля FCF на дивиденды' }, formula: 'dividends paid / free cash flow × 100, latest fiscal year (SEC 10-K)',
    unit: 'percent', basis: 'fy', source: 'sec', direction: 'lower-is-better', thresholds: { good: 70, bad: 100 },
    nullWhen: { en: 'free cash flow is zero or negative, or no dividends are reported', ru: 'свободный денежный поток нулевой или отрицательный либо дивиденды не отражены' },
    sectorNotes: { en: 'REITs: see payoutRatio', ru: 'REIT: см. payoutRatio' },
    short: { en: 'Share of free cash flow paid as dividends', ru: 'Какая доля свободного денежного потока уходит на дивиденды' },
    guide: {
      en: 'Dividends paid divided by free cash flow (operating cash flow minus capital expenditures) of the latest fiscal year. Dividends are paid in cash, so this is the stricter coverage test: below 70% is comfortable, above 100% means the dividend is funded with debt or savings. Presets treat an empty value (FCF not positive) as a failure, not as a skip',
      ru: 'Выплаченные дивиденды, делённые на свободный денежный поток (операционный поток минус капзатраты) последнего финансового года. Дивиденды платят деньгами, поэтому это более строгая проверка покрытия: ниже 70% - комфортно, выше 100% - дивиденд платится из долга или накоплений. Пресеты считают пустое значение (FCF не положителен) непрохождением, а не пропуском',
    },
  }),
];

// ---------------------------------------------------------------------------
// balance sheet and returns on capital (SEC 10-K, latest fiscal year end)

const BALANCE: MetricDef[] = [
  def({
    id: 'currentRatio', name: { en: 'Current ratio', ru: 'Текущая ликвидность' }, formula: 'current assets / current liabilities, latest fiscal year end',
    unit: 'ratio', basis: 'fy', source: 'sec', direction: 'higher-is-better', thresholds: { good: 1.5, bad: 1 }, nullWhen: { en: 'the balance sheet is not classified (banks, insurers) or a value is missing', ru: 'баланс не разделён на текущие и долгосрочные статьи (банки, страховые) или нет значения' }, sectorNotes: FIN_NOTE,
    short: { en: 'Short-term assets per dollar of short-term debts', ru: 'Оборотные активы на доллар краткосрочных обязательств' },
    guide: {
      en: 'Current assets divided by current liabilities at the latest fiscal year end (10-K). Above 1.5 is comfortable, below 1 means the company relies on new cash to pay bills due within a year. Retailers and restaurants with fast-turning inventory run safely below 1',
      ru: 'Оборотные активы, делённые на краткосрочные обязательства на конец последнего финансового года (10-K). Выше 1,5 - комфортно, ниже 1 - чтобы платить по счетам на ближайший год, нужны новые деньги. Ритейл и рестораны с быстрым оборотом запасов безопасно живут ниже 1',
    },
  }),
  def({
    id: 'quickRatio', name: { en: 'Quick ratio', ru: 'Быстрая ликвидность' }, formula: '(cash and short-term investments + receivables) / current liabilities, latest fiscal year end',
    unit: 'ratio', basis: 'fy', source: 'sec', direction: 'higher-is-better', thresholds: { good: 1, bad: 0.5 }, nullWhen: { en: 'no cash or current liabilities are reported (banks, insurers)', ru: 'кэш или краткосрочные обязательства не отражены (банки, страховые)' }, sectorNotes: FIN_NOTE,
    short: { en: 'Cash-like assets per dollar of short-term debts', ru: 'Почти денежные активы на доллар краткосрочных обязательств' },
    guide: {
      en: 'Cash, short-term investments and receivables divided by current liabilities, without inventory. Above 1 the company can pay its short-term obligations without selling stock or borrowing; for unprofitable growers presets ask 1.5 or more because they burn cash. Not applicable to ETFs, so ETF rows skip conditions on it',
      ru: 'Кэш, краткосрочные вложения и дебиторка, делённые на краткосрочные обязательства, без запасов. Выше 1 компания покроет обязательства на год, не продавая запасы и не занимая; для растущих компаний без прибыли пресеты требуют от 1,5, потому что они сжигают деньги. К ETF не относится, поэтому у строк ETF условия на неё пропускаются',
    },
  }),
  def({
    id: 'debtToEquity', name: { en: 'Debt to equity', ru: 'Долг к капиталу' }, formula: 'total debt (short + long term, without operating leases) / shareholders\' equity, latest fiscal year end',
    unit: 'ratio', basis: 'fy', source: 'sec', direction: 'lower-is-better', thresholds: { good: 1, bad: 2 },
    nullWhen: { en: 'equity is zero or negative (often after large buybacks) or a value is missing', ru: 'капитал нулевой или отрицательный (часто после больших выкупов) или нет значения' },
    sectorNotes: { en: 'Utilities, REITs and banks run with structurally higher leverage', ru: 'Коммунальные компании, REIT и банки структурно живут с большим долгом' },
    short: { en: 'Debt per dollar of equity', ru: 'Долг на доллар собственного капитала' },
    guide: {
      en: 'Total debt divided by shareholders\' equity at the latest fiscal year end (10-K). Below 1 is conservative, above 2 is high and is the high-debt preset\'s trigger. Buybacks can push equity negative, which leaves the value empty: read netDebtToEbitda for such companies',
      ru: 'Весь долг, делённый на собственный капитал на конец последнего финансового года (10-K). Ниже 1 - консервативно, выше 2 - много, это порог пресета «Высокий долг». Выкупы могут сделать капитал отрицательным, тогда значение пустое: для таких компаний смотрят netDebtToEbitda',
    },
  }),
  def({
    id: 'netDebtToEbitda', name: { en: 'Net debt / EBITDA', ru: 'Чистый долг / EBITDA' }, formula: '(debt - cash - short-term investments - long-term investments) / (operating income + D&A); balance of the last quarter, EBITDA TTM',
    unit: 'ratio', basis: 'ttm', source: 'sec', direction: 'lower-is-better', thresholds: { good: 2.5, bad: 3 },
    nullWhen: { en: 'EBITDA is zero or negative or a value is missing; a company without any debt line in the last 3 years counts debt 0', ru: 'EBITDA нулевая или отрицательная либо нет значения; у компании без строк долга за последние 3 года долг считается равным 0' }, sectorNotes: FIN_NOTE,
    short: { en: 'Years of EBITDA needed to repay net debt', ru: 'За сколько лет EBITDA погасит чистый долг' },
    guide: {
      en: 'Debt minus cash and investments of the last quarter, divided by the EBITDA of the trailing twelve months (operating income plus depreciation and amortization from the 10-K and 10-Q; it used the latest fiscal year before the quarterly layer). Empty for banks and insurers. A company that has tagged no debt line for 3 years counts debt 0. A negative value means more cash than debt. Below 2.5 is safe, above 3 is high for most industries. It reads better than debt to equity when buybacks have wiped out equity',
      ru: 'Долг минус кэш и вложения на последний квартал, делённый на EBITDA за последние двенадцать месяцев (операционная прибыль плюс амортизация из 10-K и 10-Q; до квартального слоя бралась EBITDA последнего финансового года). У банков и страховых пусто. Компания, 3 года не размечающая строк долга, считается без долга (0). Отрицательное значение - денег больше, чем долга. Ниже 2,5 - безопасно, выше 3 - много для большинства отраслей. Метрика понятнее долга к капиталу, когда выкупы обнулили капитал',
    },
  }),
  def({
    id: 'roic', name: { en: 'ROIC', ru: 'ROIC' }, formula: 'operating income × (1 - effective tax rate) / average invested capital (debt + equity - cash) of the last two fiscal year ends × 100',
    unit: 'percent', basis: 'fy', source: 'sec', direction: 'higher-is-better', thresholds: { good: 15, bad: 8 },
    nullWhen: { en: 'invested capital is zero or negative or a value is missing; a tax rate outside 0-50% is replaced by 21%', ru: 'инвестированный капитал нулевой или отрицательный либо нет значения; ставка налога вне 0-50% заменяется на 21%' },
    sectorNotes: { en: 'Not meaningful for banks and insurers, whose debt is raw material', ru: 'Не имеет смысла для банков и страховых, у которых долг - сырьё бизнеса' },
    short: { en: 'After-tax operating return on the capital the business uses', ru: 'Операционная доходность после налога на капитал бизнеса' },
    guide: {
      en: 'Return on invested capital: operating income after tax divided by the average of debt plus equity minus cash over the last two fiscal year ends. It shows how well management turns capital into profit, regardless of how it is financed. Above 15% points to a moat, below 8% is under the usual cost of capital, so growth then destroys value',
      ru: 'Доходность инвестированного капитала: операционная прибыль после налога, делённая на среднее за два последних года значение долга плюс капитала минус кэш. Показывает, насколько хорошо менеджмент превращает капитал в прибыль, независимо от способа финансирования. Выше 15% говорит о конкурентном преимуществе, ниже 8% - меньше обычной стоимости капитала, и тогда рост разрушает стоимость',
    },
  }),
];

// ---------------------------------------------------------------------------
// growth (SEC 10-K annual rows, Yahoo fundamentals-timeseries fills gaps)

type GrowthBase = { key: string; en: string; ru: string; direction: Direction; read: Text };
/** Revenue, assets and debt are words, EPS, FCF, EBITDA and CapEx stay as written inside a sentence */
const inSentence = (b: GrowthBase): string => (['Revenue', 'Assets', 'Debt'].indexOf(b.en) >= 0 ? b.en.toLowerCase() : b.en);
const GROWTH_BASES: GrowthBase[] = [
  { key: 'revenue', en: 'Revenue', ru: 'выручки', direction: 'higher-is-better', read: { en: 'Sustained double-digit growth marks a grower; 3-5% is a mature business keeping pace with inflation', ru: 'Устойчивый двузначный рост - признак растущей компании; 3-5% - зрелый бизнес на уровне инфляции' } },
  { key: 'eps', en: 'EPS', ru: 'EPS', direction: 'higher-is-better', read: { en: 'EPS is diluted earnings per share; it can grow faster than net income thanks to buybacks', ru: 'EPS - разводнённая прибыль на акцию; она может расти быстрее чистой прибыли за счёт выкупов' } },
  { key: 'fcf', en: 'FCF', ru: 'FCF', direction: 'higher-is-better', read: { en: 'FCF is operating cash flow minus capital expenditures; it swings with investment cycles, so prefer the 3 and 5-year rates', ru: 'FCF - операционный денежный поток минус капзатраты; он скачет вместе с циклом инвестиций, поэтому надёжнее темпы за 3 и 5 лет' } },
  { key: 'ebitda', en: 'EBITDA', ru: 'EBITDA', direction: 'higher-is-better', read: { en: 'EBITDA here is operating income plus depreciation and amortization from the filings', ru: 'EBITDA здесь - операционная прибыль плюс амортизация по отчётности' } },
  { key: 'capex', en: 'CapEx', ru: 'капзатрат', direction: 'neutral', read: { en: 'Rising capital expenditures mean investment in future capacity, which lowers FCF today; compare with revenue growth', ru: 'Рост капзатрат - вложения в будущие мощности, которые сегодня снижают FCF; сравнивают с ростом выручки' } },
  { key: 'assets', en: 'Assets', ru: 'активов', direction: 'neutral', read: { en: 'Total assets grow with acquisitions and retained profits; assets growing much faster than revenue lower capital efficiency', ru: 'Активы растут от поглощений и нераспределённой прибыли; активы, растущие намного быстрее выручки, снижают эффективность капитала' } },
  { key: 'debt', en: 'Debt', ru: 'долга', direction: 'lower-is-better', read: { en: 'Debt is short plus long-term borrowings without operating leases; debt growing faster than EBITDA raises the leverage', ru: 'Долг - краткосрочные и долгосрочные займы без операционной аренды; долг, растущий быстрее EBITDA, повышает нагрузку' } },
];

const GROWTH: MetricDef[] = GROWTH_BASES.flatMap((b) => ([1, 3, 5] as const).map((n) => {
  const suffix = n === 1 ? '' : `${n}y`;
  const ruYears = n === 1 ? '1 год' : n === 3 ? '3 года' : '5 лет';
  const formula = n === 1 ? `(${b.key} FY0 - ${b.key} FY-1) / |${b.key} FY-1| × 100` : `((${b.key} FY0 / ${b.key} FY-${n})^(1/${n}) - 1) × 100`;
  return def({
    id: `${b.key}Growth${suffix}`, name: { en: `${b.en} growth ${n}Y`, ru: `Рост ${b.ru} за ${ruYears}` }, formula,
    unit: 'percent', basis: 'fy', source: 'sec', direction: b.direction,
    nullWhen: n === 1
      ? { en: 'the previous value is missing or zero, or the two fiscal years are not about a year apart', ru: 'нет прошлого значения или оно равно нулю либо два финансовых года не идут подряд' }
      : { en: `an endpoint is missing, zero or negative (a CAGR needs two positive endpoints) or the fiscal years are not ${n} years apart`, ru: `нет одной из крайних точек или она не положительна (CAGR требует двух положительных точек) либо года не отстоят на ${ruYears}` },
    short: n === 1
      ? { en: `${b.en} change over the latest fiscal year`, ru: `Изменение ${b.ru} за последний финансовый год` }
      : { en: `Average yearly ${inSentence(b)} growth over ${n} fiscal years (CAGR)`, ru: `Среднегодовой рост ${b.ru} за ${ruYears} (CAGR)` },
    guide: {
      en: n === 1
        ? `Change of ${inSentence(b)} in the latest fiscal year of the 10-K relative to the absolute previous value, so a move from a loss to a profit reads as positive. ${b.read.en}. One year is noisy: confirm with the 3 and 5-year rates`
        : `Compound annual growth over ${n} fiscal years from the 10-K annual rows: both endpoints must be positive and exactly ${n} years apart. ${b.read.en}. Fundamentals describe the latest fiscal year, not the trailing twelve months`,
      ru: n === 1
        ? `Изменение ${b.ru} за последний финансовый год по 10-K относительно модуля прошлого значения, поэтому переход от убытка к прибыли читается как рост. ${b.read.ru}. Один год шумный: подтверждают темпами за 3 и 5 лет`
        : `Среднегодовой темп за ${ruYears} по годовым строкам 10-K: обе крайние точки должны быть положительными и отстоять ровно на ${ruYears}. ${b.read.ru}. Фундаментал описывает последний финансовый год, а не последние двенадцать месяцев`,
    },
  });
}));

// ---------------------------------------------------------------------------
// margins and their changes

type MarginBase = { key: string; en: string; ru: string; num: string; numRu: string; read: Text; good?: number };
const MARGIN_BASES: MarginBase[] = [
  { key: 'netMargin', en: 'Net margin', ru: 'Чистая маржа', num: 'net income', numRu: 'чистая прибыль', good: 10, read: { en: 'Above 10% is healthy for most industries; one-off gains and write-downs move it, so check the operating picture too', ru: 'Выше 10% - хорошо для большинства отраслей; разовые доходы и списания двигают её, поэтому смотрят и на операционную картину' } },
  { key: 'grossMargin', en: 'Gross margin', ru: 'Валовая маржа', num: 'gross profit', numRu: 'валовая прибыль', good: 40, read: { en: 'Above 50% suggests pricing power (software, brands); below 20% is a volume business (retail, distribution)', ru: 'Выше 50% говорит о ценовой власти (софт, бренды); ниже 20% - бизнес на объёме (ритейл, дистрибуция)' } },
  { key: 'ebitdaMargin', en: 'EBITDA margin', ru: 'Маржа EBITDA', num: 'EBITDA (operating income + D&A)', numRu: 'EBITDA (операционная прибыль плюс амортизация)', good: 20, read: { en: 'It shows operating profitability before depreciation; capital-heavy industries have high EBITDA margins but much lower FCF margins', ru: 'Показывает операционную рентабельность до амортизации; у капиталоёмких отраслей маржа EBITDA высокая, а маржа FCF намного ниже' } },
  { key: 'fcfMargin', en: 'FCF margin', ru: 'Маржа FCF', num: 'free cash flow (CFO - capex)', numRu: 'свободный денежный поток (CFO минус капзатраты)', good: 10, read: { en: 'Above 10% is good and above 20% marks a cash machine; negative values are normal for companies in a build-out phase', ru: 'Выше 10% - хорошо, выше 20% - денежная машина; отрицательные значения нормальны для компаний в фазе стройки' } },
];

const MARGINS: MetricDef[] = MARGIN_BASES.flatMap((b) => [
  def({
    id: b.key, name: { en: b.en, ru: b.ru }, formula: `${b.num} / revenue × 100, latest fiscal year`,
    unit: 'percent', basis: 'fy', source: 'sec', direction: 'higher-is-better', thresholds: b.good === undefined ? undefined : { good: b.good },
    nullWhen: { en: 'revenue or the numerator is missing or revenue is zero', ru: 'нет выручки или числителя либо выручка равна нулю' }, sectorNotes: b.key === 'grossMargin' || b.key === 'ebitdaMargin' ? FIN_NOTE : undefined,
    short: { en: `${b.num.charAt(0).toUpperCase()}${b.num.slice(1)} as a percent of revenue`, ru: `${b.numRu.charAt(0).toUpperCase()}${b.numRu.slice(1)} в процентах от выручки` },
    guide: {
      en: `${b.num.charAt(0).toUpperCase()}${b.num.slice(1)} divided by revenue of the latest fiscal year (10-K). ${b.read.en}. Compare within a sector and watch the trend in the Delta columns`,
      ru: `${b.numRu.charAt(0).toUpperCase()}${b.numRu.slice(1)}, делённая на выручку последнего финансового года (10-K). ${b.read.ru}. Сравнивают внутри сектора и следят за трендом в колонках изменения`,
    },
  }),
  ...([1, 3] as const).map((n) => def({
    id: `${b.key}Delta${n === 1 ? '' : '3y'}`, name: { en: `${b.en} change ${n}Y`, ru: `${b.ru}: изменение за ${n === 1 ? '1 год' : '3 года'}` },
    formula: `${b.key} FY0 - ${b.key} FY-${n}, percentage points`, unit: 'pp', basis: 'fy', source: 'sec', direction: 'higher-is-better',
    nullWhen: { en: `a margin is missing or the fiscal years are not ${n === 1 ? 'one year' : 'three years'} apart`, ru: `нет одной из маржей или года не отстоят на ${n === 1 ? '1 год' : '3 года'}` },
    short: { en: `Margin change in percentage points versus ${n === 1 ? 'the previous fiscal year' : 'three fiscal years earlier'}`, ru: `Изменение маржи в процентных пунктах к ${n === 1 ? 'прошлому финансовому году' : 'году три года назад'}` },
    guide: {
      en: `The ${b.en.replace(/^(Net|Gross)/, (w) => w.toLowerCase())} of the latest fiscal year minus the one ${n === 1 ? 'a year' : 'three years'} earlier, in percentage points. A rising margin with rising revenue is operating leverage; a falling margin with rising revenue is a red flag (growth bought with price cuts or costs). ${n === 3 ? 'Three years smooth out one-off items' : 'One year can be distorted by one-off items'}`,
      ru: `${b.ru} последнего финансового года минус маржа ${n === 1 ? 'годом' : 'тремя годами'} ранее, в процентных пунктах. Растущая маржа при растущей выручке - операционный рычаг; падающая маржа при растущей выручке - красный флаг (рост куплен скидками или затратами). ${n === 3 ? 'Три года сглаживают разовые статьи' : 'Один год может исказить разовая статья'}`,
    },
  })),
]);

// ---------------------------------------------------------------------------
// price performance windows (Yahoo chart, unadjusted closes)

const PERF_WINDOWS: Array<[string, string, string, string, string]> = [
  ['perf1d', '1D', '1 день', 'the close 1 trading day earlier', 'закрытием 1 торговый день назад'],
  ['perf3d', '3D', '3 дня', 'the close 3 trading days earlier', 'закрытием 3 торговых дня назад'],
  ['perf1w', '1W', '1 неделя', 'the close 5 daily candles earlier', 'закрытием 5 дневных свечей назад'],
  ['perfWtd', 'WTD', 'с начала недели', 'the last close before the current calendar week (Monday to Sunday)', 'последним закрытием до текущей календарной недели (понедельник - воскресенье)'],
  ['perf2w', '2W', '2 недели', 'the close 10 daily candles earlier', 'закрытием 10 дневных свечей назад'],
  ['perf20d', '20D', '20 дней', 'the close 20 trading days earlier', 'закрытием 20 торговых дней назад'],
  ['perf1m', '1M', '1 месяц', 'the candle closest to the same day one month earlier', 'свечой, ближайшей к тому же дню месяц назад'],
  ['perfMtd', 'MTD', 'с начала месяца', 'the last close before the current calendar month', 'последним закрытием до текущего месяца'],
  ['perf40d', '40D', '40 дней', 'the close 40 trading days earlier', 'закрытием 40 торговых дней назад'],
  ['perf60d', '60D', '60 дней', 'the close 60 trading days earlier', 'закрытием 60 торговых дней назад'],
  ['perf1q', '1Q', '1 квартал', 'the candle closest to the same day three months earlier', 'свечой, ближайшей к тому же дню три месяца назад'],
  ['perfQtd', 'QTD', 'с начала квартала', 'the last close before the current calendar quarter', 'последним закрытием до текущего квартала'],
  ['perf4m', '4M', '4 месяца', 'the last close on or before the same date four months earlier', 'последним закрытием на ту же дату четыре месяца назад или раньше'],
  ['perf6m', '6M', '6 месяцев', 'the last close on or before the same date six months earlier', 'последним закрытием на ту же дату шесть месяцев назад или раньше'],
  ['perf52w', '52W', '52 недели', 'the last close on or before the date 52 weeks earlier', 'последним закрытием на дату 52 недели назад или раньше'],
  ['perfYtd', 'YTD', 'с начала года', 'the last close of the previous calendar year', 'последним закрытием прошлого календарного года'],
  ['perf1y', '1Y', '1 год', 'the last close on or before the same date a year earlier', 'последним закрытием на ту же дату год назад или раньше'],
  ['perf3y', '3Y', '3 года', 'the last close on or before the same date three years earlier', 'последним закрытием на ту же дату три года назад или раньше'],
  ['perf5y', '5Y', '5 лет', 'the last close on or before the same date five years earlier', 'последним закрытием на ту же дату пять лет назад или раньше'],
  ['perf10y', '10Y', '10 лет', 'the last close on or before the same date ten years earlier', 'последним закрытием на ту же дату десять лет назад или раньше'],
];

const PERFORMANCE: MetricDef[] = PERF_WINDOWS.map(([id, en, ru, anchorEn, anchorRu]) => def({
  id, name: { en: id === 'perf1y' ? 'Price return 1Y' : `Performance ${en}`, ru: id === 'perf1y' ? 'Ценовая доходность за год' : `Изменение цены за ${ru}`.replace('за с начала', 'с начала') },
  formula: `last close / ${anchorEn} - 1, × 100, unadjusted closes${id === 'perf1y' ? '; price only: the 1-year return of the presets and scores is the total return tr1y' : ''}`, unit: 'percent', basis: 'price', source: 'yahoo-chart', direction: 'higher-is-better',
  appliesTo: STOCK,
  nullWhen: { en: 'the price history does not reach back to the anchor date', ru: 'история цен не доходит до опорной даты' },
  short: { en: `Price change ${({ WTD: 'week to date', MTD: 'month to date', QTD: 'quarter to date', YTD: 'year to date' } as Record<string, string>)[en] ?? `over ${en}`}, without dividends`, ru: `Изменение цены за ${ru} без дивидендов`.replace('за с начала', 'с начала') },
  guide: {
    en: `Cumulative price change from ${anchorEn} to the last close, on unadjusted closes up to performanceAsOf, so dividends are not included (total return is in the tr columns). ${['perf1d', 'perf3d', 'perf1w', 'perf2w', 'perf20d', 'perf40d', 'perf60d'].indexOf(id) >= 0 ? 'Short windows count daily candles and depend on the date of the last candle: a stock whose performanceAsOf lags measures a different window' : 'Calendar windows anchor on dates, so stocks with the same performanceAsOf are compared on the same period'}. ${id === 'perf1y' ? 'This is the plan\'s "return for the year" metric of the stable and gold selections. ETF feeds publish only the total return for now, so an ETF row reads tr1y here (dividends included) and the column tooltip of an ETF says so. ' : ''}Momentum readers look for strength over 6-12 months, buy-low investors for pullbacks`,
    ru: `Накопленное изменение цены между ${anchorRu} и последним закрытием, по закрытиям без поправок до даты performanceAsOf, поэтому дивиденды не учтены (полная доходность - в колонках tr). ${['perf1d', 'perf3d', 'perf1w', 'perf2w', 'perf20d', 'perf40d', 'perf60d'].indexOf(id) >= 0 ? 'Короткие окна считают дневные свечи и зависят от даты последней свечи: бумага с отстающим performanceAsOf меряет другое окно' : 'Календарные окна привязаны к датам, поэтому бумаги с одинаковым performanceAsOf сравниваются на одном периоде'}. ${id === 'perf1y' ? 'Это метрика «Доходность за год» из плана, её используют выборки по растущим бумагам и золоту. Фиды ETF пока публикуют только полную доходность, поэтому у ETF здесь читается tr1y (с дивидендами), и подсказка ячейки ETF об этом говорит. ' : ''}Кто следует за импульсом, ищет силу за 6-12 месяцев, кто добирает ниже - откаты`,
  },
}));

// ---------------------------------------------------------------------------
// total returns (stocks: adjusted closes; ETFs: issuer NAV total return or Yahoo, see returnsBasis)

const TR_SPECS: Array<[string, string, string, string, string, boolean]> = [
  ['ytd', 'Total return YTD', 'Полная доходность с начала года', 'since the last close of the previous year', 'с последнего закрытия прошлого года', false],
  ['tr1y', 'Total return 1Y', 'Полная доходность за 1 год', 'over one year', 'за один год', false],
  ['tr3y', 'Total return 3Y', 'Полная доходность за 3 года', 'over three years, cumulative', 'за три года, накопленная', false],
  ['tr5y', 'Total return 5Y', 'Полная доходность за 5 лет', 'over five years, cumulative', 'за пять лет, накопленная', false],
  ['tr10y', 'Total return 10Y', 'Полная доходность за 10 лет', 'over ten years, cumulative', 'за десять лет, накопленная', false],
  ['cagr3y', 'CAGR 3Y', 'Среднегодовая доходность за 3 года', 'over three years, annualized', 'за три года в годовом выражении', true],
  ['cagr5y', 'CAGR 5Y', 'Среднегодовая доходность за 5 лет', 'over five years, annualized', 'за пять лет в годовом выражении', true],
  ['cagr10y', 'CAGR 10Y', 'Среднегодовая доходность за 10 лет', 'over ten years, annualized', 'за десять лет в годовом выражении', true],
  ['siAnn', 'Since inception, annualized', 'С запуска, в годовом выражении', 'since listing or fund inception, annualized', 'с начала торгов или запуска фонда в годовом выражении', true],
];

const TOTAL_RETURN: MetricDef[] = TR_SPECS.map(([id, en, ru, spanEn, spanRu, annual]) => def({
  id, name: { en, ru }, formula: annual ? '(end / start)^(1/years) - 1, × 100, dividend and split-adjusted' : 'end / start - 1, × 100, dividend and split-adjusted',
  unit: 'percent', basis: 'price', source: 'yahoo-chart', direction: 'higher-is-better', appliesTo: BOTH,
  nullWhen: { en: 'the history (or the fund) is younger than the horizon' + (id === 'siAnn' ? ' of one year' : ''), ru: 'история (или фонд) моложе горизонта' + (id === 'siAnn' ? ' в один год' : '') },
  short: { en: `Return with dividends reinvested ${spanEn}`, ru: `Доходность с реинвестированием дивидендов ${spanRu}` },
  guide: {
    en: `Total return ${spanEn}: price change plus reinvested dividends. ${id === 'tr1y' ? 'This is the 1-year return of the screener (Up over 1 year), for stocks and ETFs alike; perf1y is the separate price-only return. ' : ''}Stocks use dividend and split-adjusted closes of the Yahoo chart; ETFs carry the issuer's official NAV total return where the brand publishes it, else a figure derived from Yahoo, and returnsBasis says which. ${annual ? 'The annualized rate compares horizons of different length; 7-10% a year is the long-run equity average' : 'A cumulative figure: divide by the years only roughly, the CAGR columns do it exactly'}`,
    ru: `Полная доходность ${spanRu}: изменение цены плюс реинвестированные дивиденды. ${id === 'tr1y' ? 'Это доходность за год в скринере («Рост за год»), одинаково для акций и ETF; perf1y - отдельная доходность только по цене. ' : ''}У акций - по закрытиям графика Yahoo с поправкой на дивиденды и сплиты; у ETF - официальная доходность по NAV от эмитента, если бренд её публикует, иначе расчёт по Yahoo, и returnsBasis говорит, что именно. ${annual ? 'Годовой темп позволяет сравнивать горизонты разной длины; 7-10% в год - долгосрочное среднее для акций' : 'Это накопленная величина: делить её на число лет можно лишь грубо, точно это делают колонки CAGR'}`,
  },
}));

// ---------------------------------------------------------------------------
// provenance and ETF issuer fields

const META: MetricDef[] = [
  def({
    id: 'returnsBasis', name: { en: 'Returns basis', ru: 'Основа доходностей' }, formula: 'text written by the updater', unit: 'text', basis: 'meta', source: 'computed', direction: 'neutral', appliesTo: BOTH,
    short: { en: 'How the returns of the row were computed', ru: 'Как посчитаны доходности строки' },
    guide: {
      en: 'Mandatory text next to every set of returns: for stocks the Yahoo chart method (unadjusted closes for performance, adjusted closes for total return), for ETFs the issuer source such as the official NAV total return file or a Yahoo derivation. Returns from different bases are not strictly comparable',
      ru: 'Обязательный текст рядом с каждым набором доходностей: у акций - метод по графику Yahoo (закрытия без поправок для изменения цены, с поправками для полной доходности), у ETF - источник эмитента, например официальный файл доходности по NAV или расчёт по Yahoo. Доходности на разной основе строго не сравнимы',
    },
  }),
  def({
    id: 'performanceAsOf', name: { en: 'Returns as of', ru: 'Доходности на дату' }, formula: 'ISO date of the last price the returns use', unit: 'date', basis: 'meta', source: 'computed', direction: 'neutral', appliesTo: BOTH,
    nullWhen: { en: 'no returns are published', ru: 'доходности не опубликованы' },
    short: { en: 'Date the returns are measured to', ru: 'Дата, на которую посчитаны доходности' },
    guide: {
      en: 'The date of the last price the returns are measured to, not the date of the update run. Issuer ETF returns are often month-end, stock returns daily, so compare rows with the same date or use Hide stale',
      ru: 'Дата последней цены, до которой посчитаны доходности, а не дата прогона. Доходности ETF от эмитентов часто на конец месяца, у акций - дневные, поэтому сравнивают строки с одной датой или включают Hide stale',
    },
  }),
  def({
    id: 'ytdAsOf', name: { en: 'YTD as of', ru: 'YTD на дату' }, formula: 'ISO date of the issuer\'s YTD figure', unit: 'date', basis: 'meta', source: 'issuer', direction: 'neutral', appliesTo: ETF,
    short: { en: 'Date of the YTD return when it differs from the other returns', ru: 'Дата доходности YTD, если она отличается от остальных' },
    guide: {
      en: 'Some issuers publish the year-to-date return daily while the longer returns are month-end. This date belongs to the ytd value; the other horizons use performanceAsOf',
      ru: 'Некоторые эмитенты публикуют доходность с начала года ежедневно, а длинные доходности - на конец месяца. Эта дата относится к значению ytd, остальные горизонты - к performanceAsOf',
    },
  }),
  def({
    id: 'distributionYield', name: { en: 'Distribution rate', ru: 'Ставка распределения' }, formula: 'latest distribution × payments per year / price or NAV × 100 (issuer)', unit: 'percent', basis: 'issuer', source: 'issuer', direction: 'higher-is-better', appliesTo: ETF,
    nullWhen: { en: 'the issuer publishes no distribution rate', ru: 'эмитент не публикует ставку распределения' },
    short: { en: 'Latest payout annualized, as a percent of the price', ru: 'Последняя выплата в годовом выражении в процентах от цены' },
    guide: {
      en: 'The issuer\'s distribution rate: the latest distribution multiplied by the number of payments per year, divided by the price or NAV. It reacts fast to a change in payouts but overstates the yield of option-income and covered-call funds whose distributions include return of capital. Compare it with the 12-month yield and the SEC yield',
      ru: 'Ставка распределения эмитента: последняя выплата, умноженная на число выплат в год и делённая на цену или NAV. Быстро реагирует на изменение выплат, но завышает доходность опционных фондов и covered-call, где в выплатах есть возврат капитала. Её сравнивают с доходностью за 12 месяцев и SEC yield',
    },
  }),
  def({
    id: 'yield12M', name: { en: '12-month yield', ru: 'Доходность за 12 месяцев' }, formula: 'distributions of the last 12 months / price or NAV × 100 (issuer)', unit: 'percent', basis: 'ttm', source: 'issuer', direction: 'higher-is-better', appliesTo: ETF,
    nullWhen: { en: 'the issuer publishes no 12-month yield', ru: 'эмитент не публикует доходность за 12 месяцев' },
    short: { en: 'Payouts of the last year as a percent of the price', ru: 'Выплаты за последний год в процентах от цены' },
    guide: {
      en: 'The sum of the fund\'s distributions over the last 12 months divided by the price or NAV, as published by the issuer. It reflects what holders really received, including capital gains and special payouts, so a one-off year-end distribution can inflate it',
      ru: 'Сумма выплат фонда за последние 12 месяцев, делённая на цену или NAV, по данным эмитента. Показывает, что держатели реально получили, включая прирост капитала и спецвыплаты, поэтому разовая выплата в конце года может её раздуть',
    },
  }),
  def({
    id: 'secYield', name: { en: 'SEC 30-day yield', ru: 'SEC-доходность за 30 дней' }, formula: 'net investment income of the last 30 days per share / max offering price, annualized (SEC standard, issuer)', unit: 'percent', basis: 'issuer', source: 'issuer', direction: 'higher-is-better', appliesTo: ETF,
    nullWhen: { en: 'the issuer publishes no SEC yield for the fund', ru: 'эмитент не публикует SEC-доходность фонда' },
    short: { en: 'Standardized yield after fees, comparable across funds', ru: 'Стандартизированная доходность после комиссий, сравнимая между фондами' },
    guide: {
      en: 'The SEC 30-day yield is the standardized measure the SEC requires: the net investment income of the last 30 days after expenses, annualized. It excludes capital gains and return of capital, so it is the fairest yield to compare bond and dividend funds. It is net of fee waivers; secYieldUnsubsidized shows the yield without them',
      ru: 'SEC-доходность за 30 дней - стандартная мера, которую требует SEC: чистый инвестиционный доход за последние 30 дней после расходов в годовом выражении. Она не включает прирост капитала и возврат капитала, поэтому честнее всего сравнивает облигационные и дивидендные фонды. Учитывает скидки по комиссиям; secYieldUnsubsidized показывает доходность без них',
    },
  }),
  def({
    id: 'secYieldUnsubsidized', name: { en: 'SEC yield, unsubsidized', ru: 'SEC-доходность без субсидий' }, formula: 'SEC 30-day yield without fee waivers and reimbursements (issuer)', unit: 'percent', basis: 'issuer', source: 'issuer', direction: 'higher-is-better', appliesTo: ETF,
    nullWhen: { en: 'the issuer does not publish it', ru: 'эмитент её не публикует' },
    short: { en: 'SEC yield the fund would have without fee waivers', ru: 'SEC-доходность, которая была бы без скидок по комиссиям' },
    guide: {
      en: 'The SEC 30-day yield computed as if the manager did not waive part of the fees. A gap to the subsidized yield shows how much of the income depends on a waiver that can end; equal values mean no waiver',
      ru: 'SEC-доходность за 30 дней, посчитанная так, будто управляющий не снижал часть комиссий. Разница с субсидированной доходностью показывает, сколько дохода держится на скидке, которая может закончиться; равные значения - скидки нет',
    },
  }),
  def({
    id: 'indicatedDividendYield', name: { en: 'Indicated yield', ru: 'Расчётная доходность' }, formula: 'latest distribution × payments per year / NAV or price × 100 (computed by the brand updater)', unit: 'percent', basis: 'issuer', source: 'computed', direction: 'higher-is-better', appliesTo: ETF,
    nullWhen: { en: 'no recent distribution or no known payment frequency', ru: 'нет недавней выплаты или неизвестна частота выплат' },
    short: { en: 'Latest payout annualized by the updater', ru: 'Последняя выплата в годовом выражении, расчёт апдейтера' },
    guide: {
      en: 'Computed by the brand updater when the issuer publishes no yield: the latest official distribution times the payments per year, divided by the NAV or price. It follows the latest payout, so a fund with irregular payouts can look much higher or lower than its 12-month yield',
      ru: 'Считается апдейтером бренда, когда эмитент не публикует доходность: последняя официальная выплата, умноженная на число выплат в год и делённая на NAV или цену. Следует за последней выплатой, поэтому у фонда с нерегулярными выплатами может сильно отличаться от доходности за 12 месяцев',
    },
  }),
  def({
    id: 'dividendYieldBasis', name: { en: 'Yield definition', ru: 'Определение доходности' }, formula: 'code: official-trailing-12m, official-distribution-rate, official-other, computed-trailing-12m or indicated', unit: 'category', basis: 'meta', source: 'issuer', direction: 'neutral', appliesTo: ETF,
    nullWhen: { en: 'the dividend yield is empty', ru: 'дивидендная доходность пуста' },
    short: { en: 'Which definition the ETF dividend yield uses', ru: 'Какое определение у дивидендной доходности ETF' },
    guide: {
      en: 'A code that names the definition behind dividendYield of an ETF: an official trailing 12-month yield, an official distribution rate, another official yield, a 12-month yield computed by the updater, or an indicated yield. Compare yields of funds with the same code; a distribution rate usually reads higher than a trailing yield',
      ru: 'Код определения, по которому посчитана dividendYield у ETF: официальная доходность за 12 месяцев, официальная ставка распределения, другая официальная доходность, доходность за 12 месяцев, посчитанная апдейтером, или расчётная доходность. Сравнивают доходности фондов с одинаковым кодом; ставка распределения обычно выше доходности за 12 месяцев',
    },
  }),
  def({
    id: 'dividendYieldBasisText', name: { en: 'Yield definition (text)', ru: 'Определение доходности (текст)' }, formula: 'text written by the brand updater', unit: 'text', basis: 'meta', source: 'issuer', direction: 'neutral', appliesTo: ETF,
    short: { en: 'Plain-language source of the ETF dividend yield', ru: 'Источник доходности ETF простыми словами' },
    guide: {
      en: 'A sentence from the brand updater saying where the ETF dividend yield comes from, for example the official 12-month yield of the fund page, an indicated yield computed from the latest distribution, or why no yield is published (a data limitation, not a zero yield)',
      ru: 'Фраза апдейтера бренда о том, откуда взята доходность ETF: например, официальная доходность за 12 месяцев со страницы фонда, расчётная доходность по последней выплате или почему доходности нет (ограничение данных, а не нулевая доходность)',
    },
  }),
  def({
    id: 'dividendYieldSource', name: { en: 'Yield source', ru: 'Источник доходности' }, formula: 'text written by the brand updater', unit: 'text', basis: 'meta', source: 'issuer', direction: 'neutral', appliesTo: ETF,
    short: { en: 'Where the ETF dividend yield was read', ru: 'Откуда прочитана доходность ETF' },
    guide: {
      en: 'Names the page, file or computation the ETF dividend yield was taken from, so a surprising value can be traced back to the issuer. Empty in brands that describe the source in dividendYieldBasisText instead',
      ru: 'Называет страницу, файл или расчёт, откуда взята доходность ETF, чтобы неожиданное значение можно было проверить у эмитента. Пусто в брендах, которые описывают источник в dividendYieldBasisText',
    },
  }),
  def({
    id: 'dividendYieldComputed', name: { en: 'Yield computed', ru: 'Доходность рассчитана' }, formula: 'true when the updater computed the yield because the issuer published none', unit: 'flag', basis: 'meta', source: 'computed', direction: 'neutral', appliesTo: ETF,
    short: { en: 'The ETF yield is the updater\'s estimate, not the issuer\'s figure', ru: 'Доходность ETF - оценка апдейтера, а не цифра эмитента' },
    guide: {
      en: 'True when the issuer publishes no yield for the fund and the updater annualized the latest official distribution instead. Treat such yields as estimates: they move with every payout',
      ru: 'True, когда эмитент не публикует доходность фонда и апдейтер вместо неё перевёл последнюю официальную выплату в годовое выражение. Такие доходности - оценка: они меняются с каждой выплатой',
    },
  }),
  def({
    id: 'secYieldKind', name: { en: 'SEC yield kind', ru: 'Вид SEC-доходности' }, formula: 'text written by the brand updater', unit: 'text', basis: 'meta', source: 'issuer', direction: 'neutral', appliesTo: ETF,
    short: { en: 'Which SEC yield was published or why it is missing', ru: 'Какая SEC-доходность опубликована или почему её нет' },
    guide: {
      en: 'Describes the SEC yield of the row: the official 30-day yield of the fund page, or a note that the issuer does not publish one for this fund. An empty SEC yield with such a note is a data limitation, not a zero yield',
      ru: 'Описывает SEC-доходность строки: официальная доходность за 30 дней со страницы фонда или пометка, что эмитент её для этого фонда не публикует. Пустая SEC-доходность с такой пометкой - ограничение данных, а не нулевая доходность',
    },
  }),
  def({
    id: 'range52wClose', name: { en: '52-week range close', ru: 'Закрытие для годового диапазона' }, formula: 'last close of the published history used for range52w', unit: 'usd', basis: 'price', source: 'computed', direction: 'neutral', appliesTo: ETF,
    nullWhen: { en: 'fewer than two closes are published', ru: 'опубликовано меньше двух закрытий' },
    short: { en: 'The close the ETF range position is measured at', ru: 'Закрытие, по которому считается положение ETF в диапазоне' },
    guide: {
      en: 'The last close of the fund\'s published history that range52w positions between the 52-week low and high. It can differ from the row\'s headline close, which may come from another source or date',
      ru: 'Последнее закрытие опубликованной истории фонда, которое range52w располагает между минимумом и максимумом за 52 недели. Оно может отличаться от основной цены строки, взятой из другого источника или на другую дату',
    },
  }),
  def({
    id: 'range52wAsOf', name: { en: '52-week range as of', ru: 'Годовой диапазон на дату' }, formula: 'date of range52wClose', unit: 'date', basis: 'meta', source: 'computed', direction: 'neutral', appliesTo: ETF,
    short: { en: 'Date of the close used for the ETF range position', ru: 'Дата закрытия для положения ETF в диапазоне' },
    guide: {
      en: 'The date of range52wClose. Funds whose history is updated monthly show an older date here; their range position describes that day, not today',
      ru: 'Дата range52wClose. У фондов с ежемесячно обновляемой историей здесь более старая дата, и положение в диапазоне описывает тот день, а не сегодняшний',
    },
  }),
  def({
    id: 'range52wSince', name: { en: 'Range since launch', ru: 'Диапазон с запуска' }, formula: 'first published close when the history is shorter than 52 weeks, else empty', unit: 'date', basis: 'meta', source: 'computed', direction: 'neutral', appliesTo: ETF,
    short: { en: 'Start of a shorter-than-a-year range for young funds', ru: 'Начало диапазона короче года у молодых фондов' },
    guide: {
      en: 'For a fund younger than 52 weeks the range uses its whole history, and this date marks where it starts. An empty value means a full one-year window. A short window makes the range position less meaningful',
      ru: 'У фонда моложе 52 недель диапазон берётся по всей его истории, и эта дата показывает её начало. Пустое значение - полное годовое окно. Короткое окно делает положение в диапазоне менее показательным',
    },
  }),
  def({
    id: 'range52wBasis', name: { en: 'Range price column', ru: 'Ценовая колонка диапазона' }, formula: 'name of the history column used: Close, Market Price or NAV', unit: 'category', basis: 'meta', source: 'computed', direction: 'neutral', appliesTo: ETF,
    short: { en: 'Which price series the ETF range uses', ru: 'По какому ценовому ряду считается диапазон ETF' },
    guide: {
      en: 'Names the column of the fund\'s history the 52-week range is computed from: the market close, the market price or the NAV. NAV and market price differ by the premium or discount, which matters for thinly traded funds',
      ru: 'Называет колонку истории фонда, по которой считается годовой диапазон: рыночное закрытие, рыночная цена или NAV. NAV и рыночная цена различаются на премию или дисконт, что важно для малоликвидных фондов',
    },
  }),
];

/** Issuer display texts that travel next to a number in the ETF feeds: same meaning, kept to show the issuer's own formatting */
const TEXT_COMPANIONS = ['dividendYield', 'distributionYield', 'yield12M', 'secYield', 'secYieldUnsubsidized', 'indicatedDividendYield', 'ytd', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'siAnn'];

// ---------------------------------------------------------------------------
// price and swing metrics (plan 1.5 "Цена и свинги", scripts/metrics/swing.ts): stocks from the full daily Yahoo chart now,
// ETFs from the same block in the 29 brand updaters later (plan 1.6); until then an ETF row has them empty

const SWING_BASIS: Text = {
  en: 'Daily closes of the Yahoo chart, split adjusted but not dividend adjusted (the close field, not adjclose), over the whole series the updater downloads (HISTORY_RANGE, max by default: from the listing)',
  ru: 'Дневные закрытия графика Yahoo с поправкой на сплиты, но без поправки на дивиденды (поле close, не adjclose), по всему ряду, который загружает апдейтер (HISTORY_RANGE, по умолчанию max: с начала торгов)',
};
const ETF_LATER: Text = {
  en: 'ETFs get the same values from the shared block of the brand updaters (plan 1.6); until a brand publishes them the ETF row is empty',
  ru: 'ETF получат те же значения из общего блока брендовых апдейтеров (план 1.6); пока бренд их не публикует, у строки ETF значение пустое',
};
/** Every swing guide ends with the price basis and the ETF note, so each article stands on its own */
const swing = (spec: Omit<Spec, 'basis' | 'source' | 'appliesTo'>): MetricDef => def({
  ...spec, basis: 'price', source: 'yahoo-chart', appliesTo: BOTH,
  guide: { en: `${spec.guide.en}\n\nPrices: ${SWING_BASIS.en}. ${ETF_LATER.en}`, ru: `${spec.guide.ru}\n\nЦены: ${SWING_BASIS.ru}. ${ETF_LATER.ru}` },
});

const SWINGS: MetricDef[] = [
  swing({
    id: 'pctFrom52wHigh', name: { en: 'Distance from 52-week high', ru: 'Отклонение от максимума за 52 недели' }, formula: '(price / week52High - 1) × 100',
    unit: 'percent', direction: 'neutral', thresholds: { good: -20 },
    nullWhen: { en: 'no price or no 52-week high', ru: 'нет цены или максимума за 52 недели' },
    short: { en: 'How far below its 52-week high the price is', ru: 'Насколько цена ниже максимума за 52 недели' },
    guide: {
      en: 'The last price relative to the 52-week high in percent: 0 at the high, -20 means 20% below it. For stocks the high is the Yahoo intraday 52-week high (the highest close when the quoteSummary snapshot failed), so the value is usually a little below 0 even at a record close. A drawdown of 20% or more from the yearly high is the classic bear-market mark for a single stock; read it with range52w, which also knows the low',
      ru: 'Последняя цена относительно максимума за 52 недели в процентах: 0 - на максимуме, -20 - на 20% ниже. У акций максимум внутридневной из Yahoo (самое высокое закрытие, если снимок quoteSummary не загрузился), поэтому даже на рекордном закрытии значение обычно чуть ниже 0. Просадка от 20% от годового максимума - классическая отметка медвежьего рынка для отдельной бумаги; её читают вместе с range52w, который знает и минимум',
    },
  }),
  swing({
    id: 'athPrice', name: { en: 'All-time high close', ru: 'Исторический максимум закрытия' }, formula: 'max(daily close) over the whole downloaded history, split adjusted, not dividend adjusted',
    unit: 'usd', direction: 'neutral',
    nullWhen: { en: 'no price history', ru: 'нет истории цен' },
    short: { en: 'Highest daily close ever, split adjusted', ru: 'Самое высокое дневное закрытие за всю историю с поправкой на сплиты' },
    guide: {
      en: 'The highest daily close of the whole price history, adjusted for splits but not for dividends, so it is comparable with today\'s price. Intraday spikes are not counted: a close is what holders could actually sell at. athDate is its date and athBasis says which history it covers (daily closes since the first date of the series). A run with a shorter HISTORY_RANGE sees only that window, and athBasis then shows the later start',
      ru: 'Самое высокое дневное закрытие за всю историю цен с поправкой на сплиты, но не на дивиденды, поэтому оно сравнимо с сегодняшней ценой. Внутридневные выбросы не учитываются: закрытие - это цена, по которой держатель действительно мог продать. athDate - его дата, athBasis - какую историю он покрывает (дневные закрытия с первой даты ряда). Прогон с коротким HISTORY_RANGE видит только это окно, и athBasis тогда показывает более позднее начало',
    },
  }),
  swing({
    id: 'athDate', name: { en: 'All-time high date', ru: 'Дата исторического максимума' }, formula: 'date of athPrice (the earliest one on a tie)',
    unit: 'date', direction: 'neutral',
    nullWhen: { en: 'no price history', ru: 'нет истории цен' },
    short: { en: 'When the record close happened', ru: 'Когда было рекордное закрытие' },
    guide: {
      en: 'The trading day of the all-time high close, the earliest one when the record was matched later. A recent date means the stock is near its highs in a trend; a date many years back with a deep pctFromAth means a long recovery is still ahead, as with the 2000 tech peak',
      ru: 'Торговый день исторического максимума закрытия, самый ранний, если рекорд потом повторялся. Недавняя дата - бумага у максимумов в тренде; дата много лет назад вместе с глубоким pctFromAth - впереди долгое восстановление, как после пика техкомпаний 2000 года',
    },
  }),
  swing({
    id: 'athBasis', name: { en: 'All-time high basis', ru: 'Основа исторического максимума' }, formula: '"daily closes since <first date of the series>"',
    unit: 'text', direction: 'neutral',
    nullWhen: { en: 'no price history', ru: 'нет истории цен' },
    short: { en: 'Which history the all-time high covers', ru: 'Какую историю покрывает исторический максимум' },
    guide: {
      en: 'Says how deep the history behind athPrice is: daily closes since the first date of the Yahoo series. With the default HISTORY_RANGE of max that is the listing date (or the first date Yahoo has), so the value is a true all-time high; a shorter range makes it the high of that window only, and this text makes that visible',
      ru: 'Говорит, насколько глубока история за athPrice: дневные закрытия с первой даты ряда Yahoo. При HISTORY_RANGE по умолчанию (max) это дата начала торгов (или первая дата, которая есть у Yahoo), и значение - настоящий исторический максимум; более короткий диапазон делает его максимумом только этого окна, и этот текст это показывает',
    },
  }),
  swing({
    id: 'pctFromAth', name: { en: 'Distance from all-time high', ru: 'Отклонение от исторического максимума' }, formula: '(price / athPrice - 1) × 100',
    unit: 'percent', direction: 'neutral', thresholds: { good: -30 },
    nullWhen: { en: 'no price history', ru: 'нет истории цен' },
    short: { en: 'How far below its record close the price is', ru: 'Насколько цена ниже рекордного закрытия' },
    guide: {
      en: 'The last price relative to the highest close ever, split adjusted but not dividend adjusted, in percent: 0 at a record, -30 means 30% below it. Buy-low investors look for deep drawdowns in healthy businesses, and the all-time high is a natural exit target for the swing preset. A small positive value is possible when the live price is above the last record close',
      ru: 'Последняя цена относительно самого высокого закрытия за всю историю с поправкой на сплиты, но не на дивиденды, в процентах: 0 - на рекорде, -30 - на 30% ниже. Кто добирает ниже, ищет глубокие просадки у здоровых компаний, а исторический максимум - естественная цель продажи для пресета свингов. Небольшое положительное значение возможно, когда текущая цена выше последнего рекордного закрытия',
    },
  }),
  swing({
    id: 'volatility1y', name: { en: 'Volatility 1Y', ru: 'Волатильность за год' }, formula: 'sample stdev of the last 252 daily log returns ln(close[t] / close[t-1]) × √252 × 100',
    unit: 'percent', direction: 'neutral', thresholds: { good: 45 },
    nullWhen: { en: 'fewer than 253 daily closes (252 returns) or no price movement at all', ru: 'меньше 253 дневных закрытий (252 доходностей) или цена совсем не двигалась' },
    short: { en: 'Annualized size of daily price swings', ru: 'Размер дневных колебаний цены в годовом выражении' },
    guide: {
      en: 'The sample standard deviation of the last 252 daily log returns, annualized with √252, in percent. Broad index funds sit near 15%, large stable stocks at 20-30%, swing candidates at 45% and more. Higher volatility means wider swings to trade, and wider losses if the thesis is wrong. Dividends are not in the closes, so an ex-dividend day counts as a small drop',
      ru: 'Выборочное стандартное отклонение последних 252 дневных логарифмических доходностей, приведённое к году через √252, в процентах. Широкие индексные фонды - около 15%, крупные стабильные акции - 20-30%, кандидаты для свинга - от 45%. Чем выше волатильность, тем шире размах для торговли и тем больше потери, если тезис неверен. Дивиденды в закрытиях не учтены, поэтому день отсечки считается небольшим падением',
    },
  }),
  swing({
    id: 'sigmaFromMean60d', name: { en: 'Sigma from 60-day mean', ru: 'Отклонение от 60-дневной средней в σ' }, formula: '(price - mean of the last 60 closes) / sample stdev of those 60 closes',
    unit: 'ratio', direction: 'neutral',
    nullWhen: { en: 'fewer than 60 daily closes or 60 equal closes', ru: 'меньше 60 дневных закрытий или 60 одинаковых закрытий' },
    short: { en: 'How stretched the price is versus its 60-day average', ru: 'Насколько цена отклонилась от средней за 60 дней' },
    guide: {
      en: 'The distance of the last price from the average of the last 60 daily closes, in sample standard deviations of those closes. Around -2 the price is stretched to the downside, a buy zone for swing trading; around +2 it is stretched up, a zone to take profits. The average lives only inside this metric, there is no separate moving-average column',
      ru: 'Расстояние последней цены от средней последних 60 дневных закрытий в выборочных стандартных отклонениях этих закрытий. Около -2 цена растянута вниз, зона покупки для свинга; около +2 - растянута вверх, зона фиксации прибыли. Средняя живёт только внутри этой метрики, отдельной колонки скользящей средней нет',
    },
  }),
  swing({
    id: 'high60d', name: { en: '60-day high', ru: 'Максимум за 60 дней' }, formula: 'max of the last 60 daily closes',
    unit: 'usd', direction: 'neutral',
    nullWhen: { en: 'fewer than 60 daily closes', ru: 'меньше 60 дневных закрытий' },
    short: { en: 'Top of the latest swing: highest of 60 closes', ru: 'Верх последнего свинга: максимум 60 закрытий' },
    guide: {
      en: 'The highest of the last 60 daily closes, about three months of trading: the upper edge of the latest swing. A swing trader who bought near low60d sets a first profit target near this level; a close above it is a breakout of the range',
      ru: 'Самое высокое из последних 60 дневных закрытий, примерно три месяца торгов: верхняя граница последнего свинга. Свинг-трейдер, купивший у low60d, ставит первую цель фиксации прибыли около этого уровня; закрытие выше - выход из диапазона вверх',
    },
  }),
  swing({
    id: 'low60d', name: { en: '60-day low', ru: 'Минимум за 60 дней' }, formula: 'min of the last 60 daily closes',
    unit: 'usd', direction: 'neutral',
    nullWhen: { en: 'fewer than 60 daily closes', ru: 'меньше 60 дневных закрытий' },
    short: { en: 'Bottom of the latest swing: lowest of 60 closes', ru: 'Низ последнего свинга: минимум 60 закрытий' },
    guide: {
      en: 'The lowest of the last 60 daily closes: the lower edge of the latest swing. Buying close to it keeps the distance to a stop just below it short; a close under it breaks the range down and usually ends the swing idea',
      ru: 'Самое низкое из последних 60 дневных закрытий: нижняя граница последнего свинга. Покупка рядом с ним держит расстояние до стопа чуть ниже короткой; закрытие под ним ломает диапазон вниз и обычно отменяет идею свинга',
    },
  }),
];

// ---------------------------------------------------------------------------
// SEC quarters and TTM (plan 1.2, 1.5, 1.7; scripts/sec/companyfacts.ts and scripts/metrics/fundamentals.ts). TTM = last fiscal
// year + current year-to-date - the same year-to-date a year earlier (the fiscal year itself when the latest filing is a 10-K);
// balance lines at the TTM date are the last quarter. ttmAsOf on the row is the end of that quarter

const TTM_NOTE: Text = {
  en: 'TTM is the last fiscal year plus the current year-to-date minus the same year-to-date a year earlier, from the 10-K and 10-Q facts of SEC EDGAR; balance sheet lines are those of the last quarter, whose end is ttmAsOf. A foreign issuer without quarterly XBRL (most 20-F filers) uses its last fiscal year (ttmIsAnnual), in its reporting currency',
  ru: 'TTM - последний финансовый год плюс текущий период с начала года минус тот же период годом раньше, по фактам 10-K и 10-Q из SEC EDGAR; строки баланса берутся на последний квартал, его дата - ttmAsOf. Иностранный эмитент без квартального XBRL (большинство подающих 20-F) берёт последний финансовый год (ttmIsAnnual) в валюте своей отчётности',
};
const FIN_EMPTY: Text = {
  en: 'Empty for banks and insurers (Yahoo industry Banks or Insurance), plan 1.7: their EBITDA, current ratio and free cash flow carry no meaning',
  ru: 'Пусто у банков и страховых (отрасль Yahoo Banks или Insurance), план 1.7: EBITDA, текущая ликвидность и свободный денежный поток у них не имеют смысла',
};
const ttm = (spec: Spec): MetricDef => def({ ...spec, guide: { en: `${spec.guide.en}. ${TTM_NOTE.en}`, ru: `${spec.guide.ru}. ${TTM_NOTE.ru}` } });

const SEC_DERIVED: MetricDef[] = [
  ttm({
    id: 'operatingMargin', name: { en: 'Operating margin', ru: 'Операционная маржа' }, formula: 'operating income / revenue × 100, TTM (SEC 10-K and 10-Q)',
    unit: 'percent', basis: 'ttm', source: 'sec', direction: 'higher-is-better', thresholds: { good: 15 },
    nullWhen: { en: 'revenue is zero or negative or operating income is not tagged (banks report none)', ru: 'выручка нулевая или отрицательная либо операционная прибыль не размечена (у банков её нет)' },
    short: { en: 'Operating income as a percent of revenue', ru: 'Операционная прибыль в процентах от выручки' },
    guide: {
      en: 'Operating income of the trailing twelve months divided by revenue of the same months. It shows what the core business earns before interest and taxes, so it is cleaner than the net margin, which one-off gains and write-downs move. Above 15% is strong for most industries; watch its trend in operatingMarginSlope3y',
      ru: 'Операционная прибыль за последние двенадцать месяцев, делённая на выручку за те же месяцы. Показывает, сколько зарабатывает основной бизнес до процентов и налогов, поэтому чище чистой маржи, которую двигают разовые доходы и списания. Выше 15% - сильно для большинства отраслей; тренд смотрят в operatingMarginSlope3y',
    },
  }),
  def({
    id: 'grossMarginSlope3y', name: { en: 'Gross margin trend 3Y', ru: 'Тренд валовой маржи за 3 года' }, formula: 'least-squares slope of the gross margins of the latest 4 fiscal years (FY-3 to FY0), percentage points per year',
    unit: 'pp', basis: 'fy', source: 'sec', direction: 'higher-is-better', thresholds: { good: 0 },
    nullWhen: { en: 'one of the 4 fiscal years is missing, not a year apart, or has no positive revenue or gross profit', ru: 'нет одного из 4 финансовых лет, года не идут подряд или в году нет положительной выручки или валовой прибыли' },
    short: { en: 'Yearly change of the gross margin trend', ru: 'Годовое изменение тренда валовой маржи' },
    guide: {
      en: 'The slope of a straight line fitted through the gross margins of the latest four fiscal years (10-K), in percentage points per year. A rising gross margin means pricing power or a better product mix; a falling one with rising revenue means growth is bought with price cuts. Unlike the two-point grossMarginDelta3y it is not thrown off by one odd year',
      ru: 'Наклон прямой, проведённой через валовые маржи последних четырёх финансовых лет (10-K), в процентных пунктах за год. Растущая валовая маржа - ценовая власть или лучший состав продаж; падающая при растущей выручке - рост куплен скидками. В отличие от разницы двух точек grossMarginDelta3y одна странная годовая точка его не сбивает',
    },
  }),
  def({
    id: 'operatingMarginSlope3y', name: { en: 'Operating margin trend 3Y', ru: 'Тренд операционной маржи за 3 года' }, formula: 'least-squares slope of the operating margins of the latest 4 fiscal years (FY-3 to FY0), percentage points per year',
    unit: 'pp', basis: 'fy', source: 'sec', direction: 'higher-is-better', thresholds: { good: 0 },
    nullWhen: { en: 'one of the 4 fiscal years is missing, not a year apart, or has no positive revenue or operating income line', ru: 'нет одного из 4 финансовых лет, года не идут подряд или в году нет положительной выручки или строки операционной прибыли' },
    short: { en: 'Yearly change of the operating margin trend', ru: 'Годовое изменение тренда операционной маржи' },
    guide: {
      en: 'The slope of a straight line fitted through the operating margins of the latest four fiscal years (10-K), in percentage points per year. A positive slope means the business gets more profitable as it grows (operating leverage); unlike a two-point delta it is not thrown off by one odd year. The undervalued preset asks for a slope above 0',
      ru: 'Наклон прямой, проведённой через операционные маржи последних четырёх финансовых лет (10-K), в процентных пунктах за год. Положительный наклон - бизнес становится рентабельнее по мере роста (операционный рычаг); в отличие от разницы двух точек одна странная годовая точка его не сбивает. Пресет «Недооценённые» требует наклон выше 0',
    },
  }),
  ttm({
    id: 'cfoToNi', name: { en: 'Cash conversion (CFO / NI)', ru: 'Конверсия в деньги (CFO / NI)' }, formula: 'operating cash flow / net income, TTM', unit: 'ratio', basis: 'ttm', source: 'sec', direction: 'neutral', thresholds: { good: 1 },
    nullWhen: { en: 'net income is zero or negative or a value is missing', ru: 'чистая прибыль нулевая или отрицательная либо нет значения' },
    short: { en: 'Operating cash per dollar of reported profit', ru: 'Операционные деньги на доллар отчётной прибыли' },
    guide: {
      en: 'Operating cash flow divided by net income, both over the trailing twelve months. Between 0.8 and 1.5 earnings are backed by cash. Persistently below 0.8 means profits sit in receivables or inventory, the main red flag of the plan ("net income grows, cash flow does not"); far above 1.5 usually means large non-cash charges',
      ru: 'Операционный денежный поток, делённый на чистую прибыль, оба за последние двенадцать месяцев. От 0,8 до 1,5 прибыль подкреплена деньгами. Устойчиво ниже 0,8 - прибыль оседает в дебиторке или запасах, это главный красный флаг плана («прибыль растёт, денежный поток нет»); намного выше 1,5 - обычно большие неденежные списания',
    },
  }),
  ttm({
    id: 'fcfToNi', name: { en: 'FCF to net income', ru: 'FCF к чистой прибыли' }, formula: '(operating cash flow - capex) / net income, TTM', unit: 'ratio', basis: 'ttm', source: 'sec', direction: 'higher-is-better', thresholds: { good: 0.8 },
    nullWhen: { en: 'net income is zero or negative or a value is missing', ru: 'чистая прибыль нулевая или отрицательная либо нет значения' }, sectorNotes: FIN_EMPTY,
    short: { en: 'Free cash per dollar of reported profit', ru: 'Свободные деньги на доллар отчётной прибыли' },
    guide: {
      en: 'Free cash flow (operating cash flow minus capital expenditures) divided by net income over the trailing twelve months. It is the stricter cash conversion: around 1 or above means the profit is available to owners; far below 1 means a capital-hungry phase or profits that do not turn into cash',
      ru: 'Свободный денежный поток (операционный поток минус капзатраты), делённый на чистую прибыль за последние двенадцать месяцев. Это более строгая конверсия: около 1 и выше - прибыль доступна владельцам; намного ниже 1 - фаза больших вложений или прибыль, которая не превращается в деньги',
    },
  }),
  ttm({
    id: 'interestCoverage', name: { en: 'Interest coverage', ru: 'Покрытие процентов' }, formula: 'EBIT / interest expense, TTM; EBIT = operating income, else pretax income + interest expense',
    unit: 'ratio', basis: 'ttm', source: 'sec', direction: 'higher-is-better', thresholds: { good: 5, bad: 1.5 },
    nullWhen: { en: 'interest expense is zero, negative or not tagged; with zero debt interestCoverageNote says "no debt"', ru: 'процентные расходы нулевые, отрицательные или не размечены; при нулевом долге interestCoverageNote говорит «no debt»' }, sectorNotes: FIN_EMPTY,
    short: { en: 'How many times operating profit covers interest', ru: 'Во сколько раз операционная прибыль покрывает проценты' },
    guide: {
      en: 'Operating income (EBIT) of the trailing twelve months divided by the interest expense of the same months. Above 5 the debt is easily serviced, below 1.5 a weak year can make interest unpayable, a negative value means an operating loss. Not every filer tags interest expense: then the value is empty, and a company with zero debt gets the note "no debt" instead of a number',
      ru: 'Операционная прибыль (EBIT) за последние двенадцать месяцев, делённая на процентные расходы за те же месяцы. Выше 5 - долг обслуживается легко, ниже 1,5 - слабый год может сделать проценты неподъёмными, отрицательное значение - операционный убыток. Не все эмитенты размечают процентные расходы: тогда значение пустое, а компания с нулевым долгом получает пометку «no debt» вместо числа',
    },
  }),
  def({
    id: 'interestCoverageNote', name: { en: 'Interest coverage note', ru: 'Пометка к покрытию процентов' }, formula: '"no debt" when the debt at the TTM date is 0 and there is no interest expense, else empty',
    unit: 'text', basis: 'ttm', source: 'sec', direction: 'neutral', sectorNotes: FIN_EMPTY,
    short: { en: 'Why interest coverage is empty: no debt', ru: 'Почему покрытие процентов пустое: нет долга' },
    guide: {
      en: 'Explains an empty interestCoverage: "no debt" means the balance sheet of the last quarter shows zero debt and no interest is paid, which is the best possible coverage rather than missing data. An empty note next to an empty coverage means the interest expense is simply not tagged',
      ru: 'Объясняет пустое interestCoverage: «no debt» означает, что в балансе последнего квартала долг нулевой и проценты не платятся, это лучшее возможное покрытие, а не нехватка данных. Пустая пометка рядом с пустым покрытием значит, что процентные расходы просто не размечены',
    },
  }),
  ttm({
    id: 'cashRunwayMonths', name: { en: 'Cash runway', ru: 'Запас кэша' }, formula: '(cash + short-term investments) / (-FCF TTM / 12), months; only when FCF TTM < 0',
    unit: 'count', basis: 'ttm', source: 'sec', direction: 'higher-is-better', thresholds: { good: 24, bad: 12 },
    nullWhen: { en: 'free cash flow is zero or positive (the company does not burn cash) or a value is missing', ru: 'свободный денежный поток нулевой или положительный (компания не сжигает деньги) или нет значения' }, sectorNotes: FIN_EMPTY,
    short: { en: 'Months the cash lasts at the current burn', ru: 'На сколько месяцев хватит денег при текущем расходе' },
    guide: {
      en: 'For a company that burns cash: cash and short-term investments of the last quarter divided by the monthly burn, where the burn is the negative free cash flow of the trailing twelve months divided by 12. Below 12 months the company will likely raise money soon (dilution or debt), which is the stop factor of the growing archetype; above 24 it has time. Empty for companies with positive free cash flow',
      ru: 'Для компании, которая сжигает деньги: кэш и краткосрочные вложения последнего квартала, делённые на месячный расход, где расход - отрицательный свободный денежный поток за двенадцать месяцев, делённый на 12. Меньше 12 месяцев - компания скоро будет привлекать деньги (размытие или долг), это стоп-фактор архетипа растущих; больше 24 - время есть. Пусто у компаний с положительным свободным потоком',
    },
  }),
  ttm({
    id: 'altmanZ', name: { en: 'Altman Z-score', ru: 'Altman Z-score' }, formula: 'classic: 1.2·X1 + 1.4·X2 + 3.3·X3 + 0.6·market cap / liabilities + 1.0·revenue / assets; Z\'\': 6.56·X1 + 3.26·X2 + 6.72·X3 + 1.05·equity / liabilities; X1 = working capital / assets, X2 = retained earnings / assets, X3 = EBIT TTM / assets',
    unit: 'ratio', basis: 'ttm', source: 'computed', direction: 'higher-is-better', thresholds: { good: 2.99, bad: 1.81 },
    nullWhen: { en: 'a bank, insurer or REIT, or a line is missing (current assets, current liabilities, retained earnings, liabilities, operating income); assets or liabilities not positive', ru: 'банк, страховая или REIT либо нет строки (оборотные активы, краткосрочные обязательства, нераспределённая прибыль, обязательства, операционная прибыль); активы или обязательства не положительны' },
    sectorNotes: { en: 'The classic formula is for manufacturers (Yahoo sectors Industrials, Basic Materials, Consumer Cyclical, Consumer Defensive, Energy, Technology, Healthcare): distress below 1.81, safe above 2.99. Other sectors get Z\'\': distress below 1.1, safe above 2.6. altmanVariant says which one', ru: 'Классическая формула - для производственных компаний (сектора Yahoo Industrials, Basic Materials, Consumer Cyclical, Consumer Defensive, Energy, Technology, Healthcare): дистресс ниже 1,81, безопасно выше 2,99. Остальные сектора получают Z\'\': дистресс ниже 1,1, безопасно выше 2,6. Вариант записан в altmanVariant' },
    short: { en: 'Bankruptcy risk score from the balance sheet and profits', ru: 'Оценка риска банкротства по балансу и прибыли' },
    guide: {
      en: 'Edward Altman\'s bankruptcy predictor combines liquidity (working capital to assets), accumulated profits (retained earnings to assets), operating profitability (EBIT to assets), the cushion of equity over liabilities and, in the classic version, asset turnover. Balance lines are those of the last quarter, EBIT and revenue are TTM. Manufacturers get the classic score (distress below 1.81, safe above 2.99), other sectors the Z\'\' score without the sales term (distress below 1.1, safe above 2.6). Large buybacks shrink retained earnings and can pull a healthy company down, so read it together with interest coverage',
      ru: 'Предиктор банкротства Эдварда Альтмана объединяет ликвидность (оборотный капитал к активам), накопленную прибыль (нераспределённая прибыль к активам), операционную рентабельность (EBIT к активам), запас капитала над обязательствами и, в классическом варианте, оборачиваемость активов. Строки баланса - на последний квартал, EBIT и выручка - TTM. Производственные компании получают классическую оценку (дистресс ниже 1,81, безопасно выше 2,99), остальные - Z\'\' без слагаемого продаж (дистресс ниже 1,1, безопасно выше 2,6). Большие выкупы уменьшают нераспределённую прибыль и могут занизить оценку здоровой компании, поэтому её читают вместе с покрытием процентов',
    },
  }),
  def({
    id: 'altmanVariant', name: { en: 'Altman Z variant', ru: 'Вариант Altman Z' }, formula: '"classic" for the manufacturing sectors, "z2" (Z\'\') for the others; empty when altmanZ is empty',
    unit: 'category', basis: 'meta', source: 'computed', direction: 'neutral',
    short: { en: 'Which Altman formula and thresholds apply', ru: 'Какая формула Альтмана и какие пороги применены' },
    guide: {
      en: 'The variant behind altmanZ: "classic" (manufacturers, uses market cap and sales, distress below 1.81, safe above 2.99) or "z2" (Z\'\' for non-manufacturers, uses book equity and no sales term, distress below 1.1, safe above 2.6). The two scales differ, so compare scores only within one variant',
      ru: 'Вариант формулы altmanZ: «classic» (производственные компании, капитализация и продажи, дистресс ниже 1,81, безопасно выше 2,99) или «z2» (Z\'\' для непроизводственных, балансовый капитал и без продаж, дистресс ниже 1,1, безопасно выше 2,6). Шкалы разные, поэтому оценки сравнивают только внутри одного варианта',
    },
  }),
  def({
    id: 'piotroskiF', name: { en: 'Piotroski F-score', ru: 'Piotroski F-score' }, formula: 'one point each, latest fiscal year vs the one before: NI / assets > 0, CFO > 0, NI / assets up, CFO > NI, long-term debt / assets down (or none), current ratio up, diluted weighted shares not up, gross margin up, revenue / assets up',
    unit: 'count', basis: 'fy', source: 'sec', direction: 'higher-is-better', thresholds: { good: 7, bad: 3 },
    nullWhen: { en: 'any of the 9 tests cannot be computed (a missing line in either year, banks and insurers)', ru: 'хотя бы один из 9 пунктов не считается (нет строки в одном из лет, банки и страховые)' }, sectorNotes: FIN_EMPTY,
    short: { en: 'Nine yes-or-no tests of improving financial health, 0 to 9', ru: 'Девять проверок улучшения финансового здоровья, от 0 до 9' },
    guide: {
      en: 'Joseph Piotroski\'s score gives a point for each of nine tests on the latest two fiscal years (10-K): profitable (return on assets above 0), cash generating (CFO above 0), more profitable than a year ago, cash flow above net income, less long-term debt relative to assets (or none in both years), better current ratio, no dilution (diluted weighted shares not higher), higher gross margin and higher asset turnover. Return on assets uses year-end assets. 7 to 9 is a strong, improving business, 0 to 3 a weak one. The score is empty rather than partial when any test cannot be computed',
      ru: 'Оценка Джозефа Пиотроски даёт балл за каждую из девяти проверок на двух последних финансовых годах (10-K): прибыльность (доходность активов выше 0), денежный поток (CFO выше 0), рентабельность выше прошлогодней, денежный поток выше чистой прибыли, долгосрочный долг к активам снизился (или его нет в обоих годах), текущая ликвидность выросла, нет размытия (средневзвешенное разводнённое число акций не выросло), валовая маржа выросла, оборачиваемость активов выросла. Доходность активов считается на активы конца года. 7-9 - сильный улучшающийся бизнес, 0-3 - слабый. Если хотя бы одна проверка не считается, оценка пустая, а не частичная',
    },
  }),
  def({
    id: 'niVolatility5y', name: { en: 'Net income volatility 5Y', ru: 'Волатильность чистой прибыли за 5 лет' }, formula: 'sample standard deviation of the 5 yearly net income growth rates of the latest 6 fiscal years, percentage points',
    unit: 'pp', basis: 'fy', source: 'sec', direction: 'lower-is-better', thresholds: { good: 25 },
    nullWhen: { en: 'fewer than 6 consecutive fiscal years or a base year with net income of zero or less', ru: 'меньше 6 финансовых лет подряд или базовый год с чистой прибылью не больше нуля' },
    short: { en: 'How uneven profit growth has been', ru: 'Насколько неровно росла прибыль' },
    guide: {
      en: 'The standard deviation of the yearly growth rates of net income over five years, in percentage points; it needs six consecutive fiscal years (10-K) whose base years are profitable. Low values mark predictable earnings, the trait of stable compounders. The starting threshold of the undervalued preset is 25 and will be tuned after the first real runs',
      ru: 'Стандартное отклонение годовых темпов роста чистой прибыли за пять лет в процентных пунктах; нужно шесть финансовых лет подряд (10-K) с прибыльными базовыми годами. Низкие значения - предсказуемая прибыль, черта стабильных компаний. Стартовый порог пресета «Недооценённые» - 25, он будет подстроен после первых реальных прогонов',
    },
  }),
  def({
    id: 'fcfVolatility5y', name: { en: 'FCF volatility 5Y', ru: 'Волатильность FCF за 5 лет' }, formula: 'sample standard deviation of the 5 yearly FCF (CFO - capex) growth rates of the latest 6 fiscal years, percentage points',
    unit: 'pp', basis: 'fy', source: 'sec', direction: 'lower-is-better', thresholds: { good: 30 },
    nullWhen: { en: 'fewer than 6 consecutive fiscal years or a base year with FCF of zero or less', ru: 'меньше 6 финансовых лет подряд или базовый год с FCF не больше нуля' }, sectorNotes: FIN_EMPTY,
    short: { en: 'How uneven free cash flow growth has been', ru: 'Насколько неровно рос свободный денежный поток' },
    guide: {
      en: 'The standard deviation of the yearly growth rates of free cash flow over five years, in percentage points, from six consecutive fiscal years (10-K) with positive base years. FCF is naturally lumpier than earnings because capital spending comes in waves, so its threshold is looser. Very high values mean the cash flow cannot be extrapolated',
      ru: 'Стандартное отклонение годовых темпов роста свободного денежного потока за пять лет в процентных пунктах, по шести финансовым годам подряд (10-K) с положительными базовыми годами. FCF от природы неровнее прибыли, потому что капзатраты идут волнами, поэтому порог мягче. Очень высокие значения означают, что денежный поток нельзя экстраполировать',
    },
  }),
  ttm({
    id: 'capexToCfo', name: { en: 'CapEx to operating cash flow', ru: 'Капзатраты к операционному потоку' }, formula: 'capital expenditures / operating cash flow × 100, TTM',
    unit: 'percent', basis: 'ttm', source: 'sec', direction: 'lower-is-better', thresholds: { good: 30, bad: 80 },
    nullWhen: { en: 'operating cash flow is zero or negative or capex is not tagged', ru: 'операционный поток нулевой или отрицательный либо капзатраты не размечены' },
    short: { en: 'Share of operating cash reinvested in fixed assets', ru: 'Доля операционных денег, вложенная в основные средства' },
    guide: {
      en: 'Capital expenditures divided by operating cash flow over the trailing twelve months. Below 30% leaves most of the cash for owners; above 80% the business consumes its own cash to grow or to stand still. Compare with the 3-year change of capex intensity to tell a build-out from a structural need',
      ru: 'Капзатраты, делённые на операционный денежный поток за последние двенадцать месяцев. Ниже 30% - большая часть денег остаётся владельцам; выше 80% - бизнес съедает собственные деньги, чтобы расти или просто стоять на месте. Сравнивают с изменением доли капзатрат за 3 года, чтобы отличить стройку от структурной потребности',
    },
  }),
  ttm({
    id: 'capexToRevenue', name: { en: 'CapEx intensity', ru: 'Капиталоёмкость' }, formula: 'capital expenditures / revenue × 100, TTM',
    unit: 'percent', basis: 'ttm', source: 'sec', direction: 'lower-is-better',
    nullWhen: { en: 'revenue is zero or negative or capex is not tagged', ru: 'выручка нулевая или отрицательная либо капзатраты не размечены' },
    short: { en: 'Capital spending as a percent of revenue', ru: 'Капзатраты в процентах от выручки' },
    guide: {
      en: 'Capital expenditures divided by revenue over the trailing twelve months. Software and services spend a few percent, utilities, telecom and chipmakers 15-30% and more. It sets how much of the operating margin can become free cash flow, so compare it within an industry',
      ru: 'Капзатраты, делённые на выручку за последние двенадцать месяцев. Софт и услуги тратят несколько процентов, коммунальные компании, связь и производители чипов - 15-30% и больше. Она определяет, какая часть операционной маржи может стать свободным денежным потоком, поэтому её сравнивают внутри отрасли',
    },
  }),
  def({
    id: 'capexToRevenueDelta3y', name: { en: 'CapEx intensity change 3Y', ru: 'Изменение доли капзатрат за 3 года' }, formula: 'capex / revenue × 100 of the latest fiscal year - the same of the fiscal year 3 years earlier, percentage points', unit: 'pp', basis: 'fy', source: 'sec', direction: 'lower-is-better', thresholds: { good: 0 },
    nullWhen: { en: 'revenue (positive) or capex is missing for an endpoint, or the fiscal years are not 3 years apart', ru: 'нет выручки (положительной) или капзатрат в одной из крайних точек либо года не отстоят на 3 года' },
    short: { en: 'Change of capital spending as a share of revenue', ru: 'Изменение капзатрат как доли выручки' },
    guide: {
      en: 'Capital expenditures as a share of revenue in the latest fiscal year (10-K) minus the same share three fiscal years earlier, in percentage points. Zero or below means growth does not need ever more investment, which is what the cash-flow machines preset wants. A rising share can be a deliberate build-out; read it together with revenue growth',
      ru: 'Доля капзатрат в выручке последнего финансового года (10-K) минус та же доля три финансовых года назад, в процентных пунктах. Ноль и ниже - росту не нужно всё больше вложений, именно этого ждёт пресет «Кэшфлоу-машины». Растущая доля может быть сознательной стройкой; её читают вместе с ростом выручки',
    },
  }),
  ...([3, 5] as const).map((n) => def({
    id: `niGrowth${n}y`, name: { en: `Net income growth ${n}Y`, ru: `Рост чистой прибыли за ${n === 3 ? '3 года' : '5 лет'}` }, formula: `((net income FY0 / net income FY-${n})^(1/${n}) - 1) × 100 (SEC 10-K)`,
    unit: 'percent', basis: 'fy', source: 'sec', direction: 'higher-is-better', thresholds: n === 5 ? { good: 8 } : undefined,
    nullWhen: { en: `an endpoint is missing, zero or negative (a CAGR needs two positive endpoints) or the fiscal years are not ${n} years apart`, ru: `нет одной из крайних точек или она не положительна (CAGR требует двух положительных точек) либо года не отстоят на ${n === 3 ? '3 года' : '5 лет'}` },
    short: { en: `Average yearly net income growth over ${n} fiscal years (CAGR)`, ru: `Среднегодовой рост чистой прибыли за ${n === 3 ? '3 года' : '5 лет'} (CAGR)` },
    guide: {
      en: `Compound annual growth of net income over ${n} fiscal years from the 10-K: both endpoints must be positive and exactly ${n} years apart. Compare it with epsGrowth${n}y: EPS growing much faster than net income means buybacks, not a better business, do the work`,
      ru: `Среднегодовой темп роста чистой прибыли за ${n === 3 ? 'три года' : 'пять лет'} по 10-K: обе крайние точки должны быть положительными и отстоять ровно на ${n === 3 ? '3 года' : '5 лет'}. Сравнивают с epsGrowth${n}y: если EPS растёт намного быстрее чистой прибыли, работу делают выкупы, а не улучшение бизнеса`,
    },
  })),
  ttm({
    id: 'revenueTtm', name: { en: 'Revenue (TTM)', ru: 'Выручка (TTM)' }, formula: 'revenue of the trailing twelve months, SEC layer in USD (a foreign issuer: its USD view at the period average rates)',
    unit: 'usd', basis: 'ttm', source: 'sec', direction: 'neutral',
    nullWhen: { en: 'no SEC layer (the Yahoo fallback, a failed or stale 20-F) or revenue is not tagged', ru: 'нет слоя SEC (запасной вариант Yahoo, неудачный или устаревший 20-F) или выручка не размечена' },
    short: { en: 'Sales of the last twelve months in USD', ru: 'Продажи за последние двенадцать месяцев в USD' },
    guide: {
      en: 'The revenue of the trailing twelve months as an amount in US dollars, from the same SEC layer as the margins and EV/EBITDA. It sizes the business by sales rather than by market value, which helps when comparing peers: the peers table on the ticker page reads it directly (before, it derived revenue as market cap / P/S). Banks tag revenue net of interest expense or not, so compare them with care',
      ru: 'Выручка за последние двенадцать месяцев суммой в долларах США, из того же слоя SEC, что маржи и EV/EBITDA. Она показывает размер бизнеса по продажам, а не по рыночной стоимости, и помогает сравнивать пиров: таблица пиров на странице тикера берёт её напрямую (раньше выручка выводилась как капитализация / P/S). Банки размечают выручку то за вычетом процентных расходов, то без, поэтому их сравнивают осторожно',
    },
  }),
  ttm({
    id: 'netIncomeTtm', name: { en: 'Net income (TTM)', ru: 'Чистая прибыль (TTM)' }, formula: 'net income of the trailing twelve months, SEC layer in USD (a foreign issuer: its USD view at the period average rates)',
    unit: 'usd', basis: 'ttm', source: 'sec', direction: 'higher-is-better',
    nullWhen: { en: 'no SEC layer or net income is not tagged; a loss is a negative amount, not empty', ru: 'нет слоя SEC или чистая прибыль не размечена; убыток - отрицательная сумма, а не пусто' },
    short: { en: 'Profit of the last twelve months in USD', ru: 'Прибыль за последние двенадцать месяцев в USD' },
    guide: {
      en: 'Net income of the trailing twelve months in US dollars, from the SEC quarters (last fiscal year + year-to-date - the same year-to-date a year earlier). The peers table shows it next to market cap, so a loss stays visible as a negative number. It includes one-off and non-operating gains (Alphabet\'s TTM held about $130B of investment gains), which a margin over a fiscal year can hide; compare it with operating income and free cash flow',
      ru: 'Чистая прибыль за последние двенадцать месяцев в долларах США, из кварталов SEC (последний финансовый год + период с начала года - тот же период годом раньше). Таблица пиров показывает её рядом с капитализацией, поэтому убыток виден как отрицательное число. В неё входят разовые и неоперационные доходы (в TTM Alphabet было около $130 млрд доходов от вложений), которые маржа за финансовый год может скрыть; сравнивайте её с операционной прибылью и свободным потоком',
    },
  }),
  ttm({
    id: 'fcfTtm', name: { en: 'Free cash flow (TTM)', ru: 'Свободный денежный поток (TTM)' }, formula: 'operating cash flow - capital expenditures of the trailing twelve months, SEC layer in USD',
    unit: 'usd', basis: 'ttm', source: 'sec', direction: 'higher-is-better',
    nullWhen: { en: 'no SEC layer, operating cash flow or capex is not tagged, or a bank or insurer (plan 1.7)', ru: 'нет слоя SEC, операционный поток или capex не размечены, либо это банк или страховая (план 1.7)' },
    sectorNotes: { en: FIN_EMPTY.en, ru: FIN_EMPTY.ru },
    short: { en: 'Cash left after investment, last twelve months, USD', ru: 'Деньги после инвестиций за последние двенадцать месяцев, USD' },
    guide: {
      en: 'Operating cash flow minus capital expenditures over the trailing twelve months, in US dollars. It is the cash the business could return to owners without shrinking, the base of the FCF flow of the DCF and of P/FCF. The peers table reads it directly instead of revenue × FCF margin of a fiscal year. A company in a heavy build-out can show a negative amount while its profits grow',
      ru: 'Операционный денежный поток минус капитальные затраты за последние двенадцать месяцев в долларах США. Это деньги, которые бизнес может вернуть владельцам, не сокращаясь, - основа потока FCF в DCF и P/FCF. Таблица пиров берёт его напрямую вместо выручки × маржа FCF финансового года. Компания в фазе большой стройки может показать отрицательную сумму при растущей прибыли',
    },
  }),
  ttm({
    id: 'ffoApprox', name: { en: 'Approximate FFO', ru: 'Приблизительный FFO' }, formula: 'REITs only: net income + depreciation and amortization - gains on sale of property, TTM (a missing gain line counts 0)',
    unit: 'usd', basis: 'ttm', source: 'sec', direction: 'higher-is-better', appliesTo: STOCK,
    nullWhen: { en: 'not a REIT (Yahoo industry starting with REIT) or net income or D&A is missing', ru: 'не REIT (отрасль Yahoo не начинается с REIT) или нет чистой прибыли либо амортизации' },
    sectorNotes: { en: 'Real FFO (NAREIT) and AFFO are non-GAAP numbers the REIT publishes in its press release; they are not tagged in XBRL, so this approximation can differ from them', ru: 'Настоящий FFO (по NAREIT) и AFFO - показатели вне GAAP из пресс-релиза REIT; в XBRL они не размечены, поэтому приближение может от них отличаться' },
    short: { en: 'REIT earnings with property depreciation added back', ru: 'Прибыль REIT с возвращённой амортизацией недвижимости' },
    guide: {
      en: 'Funds from operations, approximated from the filings: net income plus depreciation and amortization minus gains on the sale of property, over the trailing twelve months. Property depreciation is a large non-cash charge for a REIT, so net income understates what it earns. The D&A line of the cash flow statement stands in for real estate depreciation (the Schedule III figure is annual only), so the value is approximate; it is not the AFFO REITs report, which also subtracts maintenance capex',
      ru: 'Средства от операций, приближённо по отчётности: чистая прибыль плюс амортизация минус прибыль от продажи объектов, за последние двенадцать месяцев. Амортизация недвижимости - большой неденежный расход REIT, поэтому чистая прибыль занижает его заработок. Вместо амортизации недвижимости берётся строка амортизации из отчёта о движении денег (цифра Schedule III есть только за год), поэтому значение приблизительное; это не AFFO из отчётов REIT, где вычитаются ещё и поддерживающие капзатраты',
    },
  }),
  ttm({
    id: 'ffoPayoutApprox', name: { en: 'Approximate FFO payout', ru: 'Доля приблизительного FFO на дивиденды' }, formula: 'REITs only: dividends paid / ffoApprox × 100, TTM',
    unit: 'percent', basis: 'ttm', source: 'sec', direction: 'lower-is-better', thresholds: { good: 80, bad: 100 },
    nullWhen: { en: 'not a REIT, approximate FFO zero or negative, or no dividends are tagged', ru: 'не REIT, приблизительный FFO нулевой или отрицательный либо дивиденды не размечены' },
    sectorNotes: { en: 'Replaces payoutRatio and fcfPayout for REITs in conditions and scores (plan 1.7)', ru: 'Для REIT заменяет payoutRatio и fcfPayout в условиях и оценках (план 1.7)' },
    short: { en: 'Share of approximate FFO paid as dividends', ru: 'Какая доля приблизительного FFO уходит на дивиденды' },
    guide: {
      en: 'Dividends paid over the trailing twelve months divided by the approximate FFO of the same months. REITs must distribute most of their taxable income, so a payout on net income looks over 100% even when the dividend is safe; on FFO below 80% is comfortable and above 100% means the dividend is not covered by operations',
      ru: 'Дивиденды, выплаченные за последние двенадцать месяцев, делённые на приблизительный FFO за те же месяцы. REIT обязаны раздавать большую часть налогооблагаемого дохода, поэтому payout от чистой прибыли выглядит выше 100%, даже когда дивиденд надёжен; от FFO ниже 80% - комфортно, выше 100% - дивиденд не покрыт операциями',
    },
  }),
];

// ---------------------------------------------------------------------------
// estimates and own history (plan 1.4 and 1.5): Yahoo quoteSummary earningsTrend, the two PEGs (owner decision В7) and the
// percentiles of the company's own 5-year monthly series, computed by the updater (scripts/metrics/estimates.ts, history.ts)

const OWN_HISTORY: Text = {
  en: 'The monthly series takes the month-end closes of the last 5 years (split adjusted), the diluted weighted shares and the TTM of 4 consecutive SEC quarters known at each month end (a quarter counts from 60 days after its end, so no value uses numbers that were not yet filed); a month with a loss or negative cash flow has no value, and at least 48 of the 60 months must have one',
  ru: 'Месячный ряд берёт закрытия на конец месяца за последние 5 лет (с поправкой на сплиты), средневзвешенное разводнённое число акций и TTM из 4 подряд кварталов SEC, известных на конец каждого месяца (квартал учитывается через 60 дней после окончания, поэтому значения не используют ещё не поданную отчётность); месяц с убытком или отрицательным денежным потоком значения не имеет, и значение должно быть хотя бы у 48 из 60 месяцев',
};

const PLANNED: MetricDef[] = [
  def({
    id: 'peg', name: { en: 'PEG ratio', ru: 'PEG' }, formula: 'forwardPe / expected yearly EPS growth in %: the 5-year consensus (earningsTrend +5y), else the next fiscal year growth (+1y); the source in pegGrowthSource', unit: 'ratio', basis: 'forward', source: 'computed', direction: 'lower-is-better', thresholds: { good: 1 },
    nullWhen: { en: 'forward P/E is empty (a loss, ADR currency mismatch) or expected growth is zero or less in both sources', ru: 'форвардный P/E пуст (убыток, разные валюты ADR) или ожидаемый рост в обоих источниках не больше нуля' },
    short: { en: 'Forward P/E per point of expected growth', ru: 'Форвардный P/E на процент ожидаемого роста' },
    guide: {
      en: 'PEG divides the forward P/E by the expected yearly EPS growth in percent: the analysts\' 5-year consensus from Yahoo earningsTrend, or the growth of the next fiscal year when the 5-year figure is missing, which is often the case; pegGrowthSource says which one was used and the tooltip shows it. Around 1 or below means the growth is not overpriced, above 2 is expensive. One year of growth is noisier than five, and forecasts are optimistic on average, so pegHist on historical growth is the cross-check',
      ru: 'PEG делит форвардный P/E на ожидаемый годовой рост EPS в процентах: консенсус аналитиков на 5 лет из Yahoo earningsTrend, а если его нет (так бывает часто) - рост следующего финансового года; pegGrowthSource говорит, какой источник взят, подсказка его показывает. Около 1 и ниже - рост не переоценён, выше 2 - дорого. Рост одного года шумнее пятилетнего, а прогнозы в среднем оптимистичны, поэтому для проверки служит pegHist на историческом росте',
    },
  }),
  def({
    id: 'pegGrowthSource', name: { en: 'PEG growth source', ru: 'Источник роста для PEG' }, formula: '"5y" (earningsTrend +5y consensus) or "next-year" (growth of the next fiscal year, +1y); empty without a growth estimate or forward P/E', unit: 'category', basis: 'meta', source: 'computed', direction: 'neutral',
    short: { en: 'Which growth estimate the PEG divides by', ru: 'На какой прогноз роста делится PEG' },
    guide: {
      en: 'Names the growth behind peg: "5y" is the analysts\' consensus for yearly EPS growth over five years, "next-year" the expected EPS growth of the next fiscal year, used when Yahoo has no 5-year figure. A next-year PEG swings with one year of recovery or decline, so compare PEGs of the same source',
      ru: 'Называет рост, на который делится peg: «5y» - консенсус аналитиков по годовому росту EPS на пять лет, «next-year» - ожидаемый рост EPS следующего финансового года, он берётся, когда у Yahoo нет пятилетней цифры. PEG на росте одного года скачет вместе с восстановлением или спадом этого года, поэтому сравнивают PEG одного источника',
    },
  }),
  def({
    id: 'pegHist', name: { en: 'Historical PEG', ru: 'Исторический PEG' }, formula: 'pe / CAGR of diluted EPS over the latest 3 fiscal years in % (SEC 10-K, split restated; else epsGrowth3y)', unit: 'ratio', basis: 'fy', source: 'computed', direction: 'lower-is-better', thresholds: { good: 1 },
    nullWhen: { en: 'P/E is empty (a loss) or the 3-year EPS CAGR is not positive or cannot be computed', ru: 'P/E пуст (убыток) или CAGR EPS за 3 года не положителен либо не считается' },
    short: { en: 'TTM P/E per point of past EPS growth', ru: 'P/E TTM на процент прошлого роста EPS' },
    guide: {
      en: 'The trailing P/E divided by the compound yearly growth of diluted EPS over the latest three fiscal years from the 10-K (share counts restated for splits). It needs no forecast, so it checks the forward PEG: a low forward PEG with a high historical one means the market expects growth the company has not shown yet',
      ru: 'P/E TTM, делённый на среднегодовой рост разводнённой EPS за три последних финансовых года по 10-K (с поправкой на сплиты). Он не зависит от прогнозов и поэтому проверяет форвардный PEG: низкий форвардный PEG при высоком историческом значит, что рынок ждёт роста, которого компания ещё не показывала',
    },
  }),
  def({
    id: 'forwardToTtmPe', name: { en: 'Forward to TTM P/E', ru: 'Форвардный P/E к P/E TTM' }, formula: 'forwardPe / pe', unit: 'ratio', basis: 'forward', source: 'computed', direction: 'lower-is-better', thresholds: { good: 1 },
    nullWhen: { en: 'either P/E is empty', ru: 'один из P/E пуст' },
    short: { en: 'Below 1 when earnings are expected to grow', ru: 'Ниже 1, когда ждут роста прибыли' },
    guide: {
      en: 'The forward P/E divided by the trailing P/E, both from the Yahoo snapshot. Below 1 the market expects higher earnings next year, above 1 lower ones. It turns the comparison of two metrics into one metric, which is how the screener expresses "forward P/E below TTM P/E"',
      ru: 'Форвардный P/E, делённый на P/E TTM, оба из снимка Yahoo. Ниже 1 - рынок ждёт роста прибыли в следующем году, выше 1 - снижения. Метрика превращает сравнение двух метрик в одну, так скринер выражает условие «форвардный P/E ниже P/E TTM»',
    },
  }),
  def({
    id: 'epsGrowthNextYearEst', name: { en: 'Expected EPS growth next year', ru: 'Ожидаемый рост EPS в следующем году' }, formula: 'Yahoo earningsTrend +1y growth × 100: consensus EPS of the next fiscal year over the current one', unit: 'percent', basis: 'forward', source: 'yahoo-summary', direction: 'higher-is-better',
    nullWhen: { en: 'no analyst estimates', ru: 'нет прогнозов аналитиков' },
    short: { en: 'Consensus EPS growth of the next fiscal year', ru: 'Консенсус роста EPS следующего финансового года' },
    guide: {
      en: 'How much analysts expect EPS to grow in the next fiscal year compared with the current one, from Yahoo earningsTrend. It is the fallback growth of peg. After a bad year it can be very high (recovery), so read it next to the 3 and 5-year history of EPS growth',
      ru: 'На сколько аналитики ждут роста EPS в следующем финансовом году по сравнению с текущим, из Yahoo earningsTrend. Это запасной рост для peg. После плохого года он бывает очень высоким (восстановление), поэтому его читают рядом с историей роста EPS за 3 и 5 лет',
    },
  }),
  def({
    id: 'epsGrowth5yEst', name: { en: 'Expected EPS growth 5Y', ru: 'Ожидаемый рост EPS за 5 лет' }, formula: 'Yahoo earningsTrend +5y growth × 100: consensus yearly EPS growth over five years', unit: 'percent', basis: 'forward', source: 'yahoo-summary', direction: 'higher-is-better',
    nullWhen: { en: 'Yahoo has no 5-year estimate (frequent)', ru: 'у Yahoo нет пятилетнего прогноза (бывает часто)' },
    short: { en: 'Consensus yearly EPS growth over five years', ru: 'Консенсус годового роста EPS на пять лет' },
    guide: {
      en: 'The analysts\' consensus for the yearly EPS growth over the next five years, from Yahoo earningsTrend. It is the preferred growth of peg, but Yahoo often leaves it empty; then peg uses the next-year growth and pegGrowthSource says so. Long-term forecasts are optimistic on average',
      ru: 'Консенсус аналитиков по годовому росту EPS на пять лет вперёд, из Yahoo earningsTrend. Это основной рост для peg, но Yahoo часто его не даёт; тогда peg берёт рост следующего года и pegGrowthSource это показывает. Долгосрочные прогнозы в среднем оптимистичны',
    },
  }),
  def({
    id: 'epsRevision30d', name: { en: 'EPS estimate revision 30D', ru: 'Пересмотр прогноза EPS за 30 дней' }, formula: '(current-year consensus EPS now / the same 30 days ago - 1) × 100 (Yahoo earningsTrend 0y epsTrend)', unit: 'percent', basis: 'forward', source: 'yahoo-summary', direction: 'higher-is-better',
    nullWhen: { en: 'no estimate, or the estimate now or 30 days ago is zero or negative', ru: 'нет прогноза или прогноз сейчас или 30 дней назад не положителен' },
    short: { en: 'How analysts moved this year\'s EPS estimate in a month', ru: 'Как аналитики сдвинули прогноз EPS этого года за месяц' },
    guide: {
      en: 'The change of the consensus EPS estimate for the current fiscal year against its value 30 days ago, in percent. Rising estimates tend to lift the price, falling ones lower the entry score (plan stage 5). The 7, 60 and 90-day values are kept in meta.json market.estimates',
      ru: 'Изменение консенсус-прогноза EPS на текущий финансовый год относительно значения 30 дней назад, в процентах. Растущие прогнозы обычно тянут цену вверх, падающие снижают оценку «Точка входа» (этап 5 плана). Значения 7, 60 и 90 дней назад хранятся в meta.json market.estimates',
    },
  }),
  def({
    id: 'pePct5y', name: { en: 'P/E percentile in 5 years', ru: 'Перцентиль P/E за 5 лет' }, formula: 'share of the monthly P/E values of the last 5 years below today\'s × 100; P/E = close × diluted weighted shares / TTM net income', unit: 'percent', basis: 'history', source: 'computed', direction: 'lower-is-better', thresholds: { good: 50 },
    nullWhen: { en: 'less than 5 years of prices, fewer than 48 monthly values, or a loss today', ru: 'меньше 5 лет цен, меньше 48 месячных значений или убыток сейчас' },
    short: { en: 'Where today\'s P/E sits in its own 5-year history', ru: 'Где текущий P/E в собственной истории за 5 лет' },
    guide: {
      en: `The percentile of the current P/E within the company's own monthly P/E series of the last five years, computed by the updater: 0 is the cheapest in five years, 100 the most expensive. Below 50 means cheaper than usual for this company, whatever its sector. Presets read it with scope history. ${OWN_HISTORY.en}`,
      ru: `Перцентиль текущего P/E в собственном месячном ряду P/E компании за пять лет, считается апдейтером: 0 - дешевле всего за пять лет, 100 - дороже всего. Ниже 50 - дешевле обычного для этой компании, независимо от сектора. Пресеты читают его со scope history. ${OWN_HISTORY.ru}`,
    },
  }),
  def({
    id: 'pFcfPct5y', name: { en: 'P/FCF percentile in 5 years', ru: 'Перцентиль P/FCF за 5 лет' }, formula: 'share of the monthly P/FCF values of the last 5 years below today\'s × 100; P/FCF = close × diluted weighted shares / TTM (CFO - capex)', unit: 'percent', basis: 'history', source: 'computed', direction: 'lower-is-better', thresholds: { good: 50 },
    nullWhen: { en: 'less than 5 years of prices, fewer than 48 monthly values, FCF not positive today; banks and insurers', ru: 'меньше 5 лет цен, меньше 48 месячных значений, FCF сейчас не положителен; банки и страховые' },
    short: { en: 'Where today\'s P/FCF sits in its own 5-year history', ru: 'Где текущий P/FCF в собственной истории за 5 лет' },
    guide: {
      en: `Like pePct5y, but for price to free cash flow: the percentile of today's P/FCF within the company's own monthly series of five years. It helps with companies whose earnings are distorted by non-cash charges. Low values mean the cash flow is cheap by the company's own standards. ${OWN_HISTORY.en}`,
      ru: `Как pePct5y, но для цены к свободному денежному потоку: перцентиль текущего P/FCF в собственном месячном ряду компании за пять лет. Помогает там, где прибыль искажена неденежными списаниями. Низкие значения - денежный поток дёшев по меркам самой компании. ${OWN_HISTORY.ru}`,
    },
  }),
  def({
    id: 'yieldVsAvg5y', name: { en: 'Yield vs 5-year average', ru: 'Доходность к средней за 5 лет' }, formula: 'dividendYield / mean of the month-end trailing-12-month dividend yields of the last 5 years', unit: 'ratio', basis: 'history', source: 'computed', direction: 'higher-is-better',
    nullWhen: { en: 'no dividend now, less than 5 years of prices or fewer than 48 monthly values', ru: 'нет дивиденда сейчас, меньше 5 лет цен или меньше 48 месячных значений' },
    short: { en: 'Above 1 when the yield is higher than usual', ru: 'Выше 1, когда доходность выше обычной' },
    guide: {
      en: 'The current dividend yield divided by the average of the month-end yields of the last five years (dividends of the 12 months before each month end over that month-end close, Yahoo chart), computed by the updater. Above 1 the stock pays more than usual for its price, a classic buy signal for stable dividend payers; check that the dividend itself is safe, since a yield spike can precede a cut',
      ru: 'Текущая дивидендная доходность, делённая на среднюю месячную доходность за пять лет (дивиденды за 12 месяцев до конца каждого месяца к закрытию на конец этого месяца, график Yahoo), считается апдейтером. Выше 1 - бумага платит больше обычного относительно цены, классический сигнал покупки для стабильных плательщиков; при этом проверяют надёжность дивиденда, потому что всплеск доходности может предшествовать сокращению',
    },
  }),
];

// ---------------------------------------------------------------------------
// foreign issuers (plan 1.1 and 1.3; scripts/update-data.ts, scripts/sec/fx.ts): Yahoo country, the ADR flag, an annual-only TTM

const FOREIGN: MetricDef[] = [
  def({
    id: 'isAdr', name: { en: 'ADR', ru: 'ADR' }, formula: 'the issuer is outside the United States (Yahoo assetProfile.country) and its latest annual SEC report is a 20-F',
    unit: 'flag', basis: 'meta', source: 'computed', direction: 'neutral',
    nullWhen: { en: 'Yahoo has no country for the company', ru: 'у Yahoo нет страны компании' },
    short: { en: 'Foreign company listed in the US through a 20-F', ru: 'Иностранная компания с листингом в США через 20-F' },
    guide: {
      en: 'True for a company from outside the United States that files the annual 20-F with the SEC: an ADR such as TSM or TM, or a similar US listing of foreign shares (the New York registry shares of ASML). Neither SEC nor Yahoo marks an ADR as such, so the flag is built from the Yahoo country and the SEC form; Canadian issuers on the 40-F and foreign companies filing a 10-K are false. For these rows multiples come from market cap over the SEC amounts converted to USD (P/E = market cap / net income), not from price over EPS: EPS in a 20-F is per ordinary share while the price is per ADR, and the ADR ratio is not in the SEC data',
      ru: 'True для компании не из США, которая подаёт в SEC годовой отчёт 20-F: ADR, например TSM или TM, или похожий листинг иностранных акций в США (нью-йоркские регистрационные акции ASML). Ни SEC, ни Yahoo не помечают ADR явно, поэтому флаг строится из страны по Yahoo и формы отчёта SEC; канадские эмитенты с 40-F и иностранные компании с 10-K дают false. У таких строк мультипликаторы считаются через капитализацию и суммы SEC в USD (P/E = капитализация / чистая прибыль), а не через цену и EPS: EPS в 20-F дан на обыкновенную акцию, цена - на ADR, а коэффициента ADR в данных SEC нет',
    },
  }),
  def({
    id: 'country', name: { en: 'Country', ru: 'Страна' }, formula: 'Yahoo quoteSummary assetProfile.country of the issuer',
    unit: 'category', basis: 'meta', source: 'yahoo-summary', direction: 'neutral',
    nullWhen: { en: 'Yahoo has no profile for the company', ru: 'у Yahoo нет профиля компании' },
    short: { en: 'Country of the issuer by Yahoo', ru: 'Страна эмитента по Yahoo' },
    guide: {
      en: 'The country of the company\'s address in the Yahoo profile: United States, Taiwan, Denmark, Netherlands. Use it with the in operator to keep or drop foreign issuers, or with the sector scope to compare a company with its home market peers. It is the issuer\'s country, not the exchange: every stock in the feed trades in the US',
      ru: 'Страна адреса компании в профиле Yahoo: United States, Taiwan, Denmark, Netherlands. С оператором in она оставляет или убирает иностранных эмитентов, вместе со scope sector помогает сравнивать компанию с бумагами её рынка. Это страна эмитента, а не биржи: все бумаги фида торгуются в США',
    },
  }),
  def({
    id: 'ttmIsAnnual', name: { en: 'TTM is the fiscal year', ru: 'TTM - финансовый год' }, formula: 'true when the issuer files no quarterly XBRL and TTM equals the last fiscal year',
    unit: 'flag', basis: 'ttm', source: 'sec', direction: 'neutral',
    nullWhen: { en: 'no SEC layer (the Yahoo fallback or a stale 20-F)', ru: 'нет слоя SEC (запасной вариант Yahoo или устаревший 20-F)' },
    short: { en: 'TTM values are the last annual report', ru: 'Значения TTM - последний годовой отчёт' },
    guide: {
      en: 'Most foreign issuers publish interim results in 6-K reports without XBRL, so the SEC has only their annual 20-F or 40-F facts. Their TTM is then the last fiscal year and can be up to 15 months old; ttmAsOf shows the year end. Compare such rows with US companies with care: a fast grower looks more expensive on a year-old TTM. Once that fiscal year ended more than 12 months before the last close, P/E, P/S, P/FCF, P/B and EV/EBITDA stay empty; a foreign layer older than 15 months is not used at all, the row keeps the Yahoo fallback',
      ru: 'Большинство иностранных эмитентов публикуют промежуточные результаты в отчётах 6-K без XBRL, поэтому в SEC есть только факты их годовых 20-F или 40-F. Тогда TTM - последний финансовый год, ему может быть до 15 месяцев, дату конца года показывает ttmAsOf. Такие строки сравнивают с американскими осторожно: быстрорастущая компания на годовом TTM выглядит дороже. Когда этот финансовый год закончился больше 12 месяцев назад, P/E, P/S, P/FCF, P/B и EV/EBITDA пусты; иностранный слой старше 15 месяцев не используется, строка остаётся на данных Yahoo',
    },
  }),
];

// ---------------------------------------------------------------------------
// row fields of the screener (not inside `metrics`): categories, the owner's watchlist flag and the common size

const FIELDS: MetricDef[] = [
  def({
    id: 'ticker', name: { en: 'Ticker', ru: 'Тикер' }, formula: 'exchange symbol (BRK-B style)', unit: 'category', basis: 'meta', source: 'feed', direction: 'neutral', appliesTo: BOTH,
    short: { en: 'Exchange symbol of the security', ru: 'Биржевой тикер бумаги' },
    guide: {
      en: 'The exchange symbol, with a hyphen for share classes (BRK-B). Conditions use the in operator with an explicit list, which is how the gold preset names gold ETFs that have no industry',
      ru: 'Биржевой тикер, класс акций пишется через дефис (BRK-B). Условия используют оператор in с явным списком, так пресет «Золото» перечисляет золотые ETF, у которых нет отрасли',
    },
  }),
  def({
    id: 'type', name: { en: 'Security type', ru: 'Тип бумаги' }, formula: 'stock or etf', unit: 'category', basis: 'meta', source: 'feed', direction: 'neutral', appliesTo: BOTH,
    short: { en: 'Stock or ETF', ru: 'Акция или ETF' },
    guide: {
      en: 'Stock for a row of the Stocks feed, etf for a fund of the 29 brand feeds. Stocks and ETFs live in one table; fundamental metrics of ETFs are empty, and a preset lists the types it applies to',
      ru: 'stock - строка фида Stocks, etf - фонд из фидов 29 брендов. Акции и ETF живут в одной таблице; фундаментальные метрики у ETF пусты, а пресет перечисляет, к каким типам он применяется',
    },
  }),
  def({
    id: 'sector', name: { en: 'Sector', ru: 'Сектор' }, formula: 'Yahoo assetProfile.sector; ETFs: the fund category of the brand feed', unit: 'category', basis: 'meta', source: 'yahoo-summary', direction: 'neutral', appliesTo: BOTH,
    nullWhen: { en: 'Yahoo has no profile, or the ETF brand publishes no category', ru: 'у Yahoo нет профиля или бренд ETF не публикует категорию' },
    short: { en: 'Yahoo sector of the company, fund category of an ETF', ru: 'Сектор компании по Yahoo, категория фонда у ETF' },
    guide: {
      en: 'The Yahoo sector, such as Technology or Utilities. The sector scope compares a metric with the companies of the same sector as a percentile; a sector with fewer than five companies that have the metric makes such a condition behave as missing. For an ETF the sector is its fund category from the brand feed (Equity, Fixed Income and so on): ETFs are compared only with ETFs of the same category',
      ru: 'Сектор по Yahoo, например Technology или Utilities. Scope sector сравнивает метрику с компаниями того же сектора через перцентиль; если в секторе меньше пяти компаний с этой метрикой, условие ведёт себя как пустое. У ETF сектор - категория фонда из брендового фида (Equity, Fixed Income и т. д.): ETF сравниваются только с ETF той же категории',
    },
  }),
  def({
    id: 'industry', name: { en: 'Industry', ru: 'Отрасль' }, formula: 'Yahoo assetProfile.industry', unit: 'category', basis: 'meta', source: 'yahoo-summary', direction: 'neutral', appliesTo: BOTH,
    nullWhen: { en: 'Yahoo has no profile (also every ETF for now)', ru: 'у Yahoo нет профиля (пока и у всех ETF)' },
    short: { en: 'Yahoo industry of the company', ru: 'Отрасль компании по Yahoo' },
    guide: {
      en: 'The Yahoo industry, narrower than the sector: Gold, Banks - Regional, REIT - Industrial. The gold preset selects miners with industry in [Gold, Other Precious Metals & Mining]; the industry scope ranks a metric within the industry',
      ru: 'Отрасль по Yahoo, уже сектора: Gold, Banks - Regional, REIT - Industrial. Пресет «Золото» отбирает добытчиков по отрасли из списка [Gold, Other Precious Metals & Mining]; scope industry ранжирует метрику внутри отрасли',
    },
  }),
  def({
    id: 'isMine', name: { en: 'Mine', ru: 'Мои' }, formula: 'the ticker is on the owner\'s list scripts/All.txt', unit: 'flag', basis: 'meta', source: 'user', direction: 'neutral', appliesTo: BOTH,
    short: { en: 'On the owner\'s own list', ru: 'В собственном списке владельца' },
    guide: {
      en: 'True for tickers of the owner\'s list (scripts/All.txt), stocks and ETFs alike. The Mine preset is simply isMine = true; combine it with other presets through expressions to screen only your own holdings',
      ru: 'True для тикеров из списка владельца (scripts/All.txt), и у акций, и у ETF. Пресет «Мои» - это просто isMine = true; через выражения его сочетают с другими пресетами, чтобы отбирать только среди своих бумаг',
    },
  }),
  def({
    id: 'size', name: { en: 'Size', ru: 'Размер' }, formula: 'stocks: marketCap; ETFs: aumValue (assets under management)', unit: 'usd', basis: 'snapshot', source: 'computed', direction: 'neutral', appliesTo: BOTH,
    nullWhen: { en: 'no market cap or no AUM', ru: 'нет капитализации или AUM' },
    short: { en: 'Market cap of a stock or assets of a fund, in USD', ru: 'Капитализация акции или активы фонда в USD' },
    guide: {
      en: 'One size column for stocks and ETFs: market capitalization for a stock, assets under management for a fund. It lets one condition such as size of $2B or more filter both types; tiny funds risk closing and trade with wide spreads',
      ru: 'Одна колонка размера для акций и ETF: капитализация у акции, активы под управлением у фонда. Так одно условие, например размер от $2 млрд, фильтрует оба типа; маленькие фонды рискуют закрыться и торгуются с широким спредом',
    },
  }),
];

// ---------------------------------------------------------------------------
// stage 5 inputs computed by the updater (scripts/metrics/dividends.ts, scripts/metrics/fundamentals.ts) and the outputs of the
// scoring core (src/core/scoring): scores, archetype, status, Why and flags are computed in the page from the feed and
// src/core/scoring/config.json, they are not feed keys; presets can still filter on them

const SCORING_NOTE: Text = {
  en: 'Computed in the page by src/core/scoring from the feed and the thresholds of src/core/scoring/config.json (see the guide sections Five scores, Archetypes and statuses, Thresholds); not stored in the feed',
  ru: 'Считается на странице модулем src/core/scoring по фиду и порогам из src/core/scoring/config.json (см. разделы руководства «Пять оценок», «Архетипы и статусы», «Пороги»); в фиде не хранится',
};
const scoring = (spec: Spec): MetricDef => def({ ...spec, guide: { en: `${spec.guide.en}. ${SCORING_NOTE.en}`, ru: `${spec.guide.ru}. ${SCORING_NOTE.ru}` } });
const SCORE_SPECS: Array<[string, string, string, AssetType[], string, string, string, string]> = [
  ['scoreCheap', 'Cheap', 'Дёшево', STOCK, 'peg, pegHist, forwardToTtmPe, pePct5y, pFcfPct5y, forwardPe (sector and peers)',
    'how cheap the stock is against its sector, its peers and its own history: both PEGs, forward P/E against TTM, the 5-year P/E and P/FCF percentiles and the forward P/E itself',
    'Насколько бумага дешева относительно сектора, пиров и своей истории: оба PEG, форвардный P/E к TTM, перцентили P/E и P/FCF за 5 лет и сам форвардный P/E',
    'Valuation against sector, peers and own history'],
  ['scoreQuality', 'Quality', 'Качественно', STOCK, 'roic, grossMarginSlope3y, operatingMarginSlope3y, cfoToNi, fcfToNi',
    'how good the business is: return on invested capital, the 3-year trends of the gross and operating margins and how much of the profit turns into cash',
    'Насколько хорош бизнес: доходность вложенного капитала, тренды валовой и операционной маржи за 3 года и какая доля прибыли превращается в деньги',
    'Returns on capital, margin trends, cash conversion'],
  ['scoreSafety', 'Safety', 'Безопасно', STOCK, 'debtToEquity, netDebtToEbitda, interestCoverage, altmanZ, piotroskiF, niVolatility5y, fcfVolatility5y',
    'how safe the balance sheet and the earnings are: debt to equity, net debt to EBITDA, interest coverage, Altman Z, Piotroski F and the stability of net income and free cash flow',
    'Насколько надёжны баланс и прибыль: долг к капиталу, чистый долг к EBITDA, покрытие процентов, Altman Z, Piotroski F и стабильность чистой прибыли и свободного потока',
    'Debt, coverage, distress scores, stable earnings'],
  ['scoreDividend', 'Dividend', 'Дивиденд', ['stock', 'etf'], 'dividendStreak, dividendCut10y, dividendGrowth5y, dividendYield, fcfPayout (REIT: ffoPayoutApprox)',
    'how reliable the dividend is, for payers only (dividend yield above 0): the streak of yearly increases, no cut in 10 years, 5-year growth, the yield and the share of free cash flow paid out (approximate FFO for REITs). ETFs: the yield only, their feeds publish no dividend growth yet',
    'Насколько надёжен дивиденд, только для плательщиков (доходность больше 0): стрик лет с повышением, отсутствие сокращений за 10 лет, рост за 5 лет, доходность и доля свободного потока на выплаты (у REIT - приблизительного FFO). У ETF - только доходность: роста дивиденда в их фидах пока нет',
    'Streak, no cuts, growth and payout of payers'],
  ['scoreEntry', 'Entry point', 'Точка входа', ['stock', 'etf'], 'pctFrom52wHigh, pctFromAth, range52w, sigmaFromMean60d (lower is better here); × 0.75 when epsRevision30d < 0',
    'how good the moment to buy is: the drop from the 52-week high and from the all-time high, the position in the 52-week range and the distance from the 60-day mean in sigma, all read as lower is better. A stock whose current-year EPS estimate fell in 30 days gets the score multiplied by the factor of the config. ETFs: the same without the EPS adjustment',
    'Насколько удачен момент покупки: просадка от 52-недельного и исторического максимума, положение в годовом диапазоне и отклонение от 60-дневной средней в σ, везде «ниже - лучше». Если прогноз EPS на текущий год за 30 дней снизился, оценка умножается на множитель из конфига. У ETF - то же без поправки на прогнозы',
    'Drawdown, range position and sigma: is now a good entry'],
];
const SCORES: MetricDef[] = SCORE_SPECS.map(([id, en, ru, appliesTo, formula, guideEn, guideRu, shortEn]) => scoring({
  id, name: { en: `${en} score`, ru: `Оценка «${ru}»` }, formula: `0-100: weighted mean of the sector percentiles of ${formula}; empty below half of the weight`,
  unit: 'count', basis: 'snapshot', source: 'computed', direction: 'higher-is-better', appliesTo, thresholds: { good: 70, bad: 40 },
  nullWhen: { en: 'less than half of the weight of its metrics has a value, or the score does not apply to the row (ETFs: only Dividend and Entry point; Dividend: payers only)', ru: 'значения есть меньше чем у половины веса метрик или оценка не относится к строке (у ETF только «Дивиденд» и «Точка входа»; «Дивиденд» - только у плательщиков)' },
  short: { en: shortEn, ru: guideRu.split(':')[0] },
  guide: {
    en: `Score from 0 to 100, ${guideEn}. Each metric becomes its percentile inside the sector (a sector with fewer than 20 rows compares with the whole market, ETFs with all ETFs), turned so that 100 is the best, and the score is the weighted mean of the metrics that have a value. The weights depend on the archetype`,
    ru: `Оценка от 0 до 100. ${guideRu}. Каждая метрика переводится в перцентиль внутри сектора (сектор меньше 20 бумаг сравнивается со всем рынком, ETF - со всеми ETF) так, что 100 - лучшее значение, и оценка - взвешенное среднее метрик, у которых есть значение. Веса зависят от архетипа`,
  },
}));

const SCORE_OUTPUTS: MetricDef[] = [
  ...SCORES,
  scoring({
    id: 'statusScore', name: { en: 'Status score', ru: 'Итоговая оценка' }, formula: 'weighted mean of the five scores with the score weights of the archetype; compared with the buy and reject thresholds of the archetype',
    unit: 'count', basis: 'snapshot', source: 'computed', direction: 'higher-is-better', appliesTo: BOTH,
    nullWhen: { en: 'less than half of the weight of the scores that apply to the row has a value', ru: 'значения есть меньше чем у половины веса оценок, относящихся к строке' },
    short: { en: 'Weighted sum of the five scores behind the status', ru: 'Взвешенная сумма пяти оценок, по которой ставится статус' },
    guide: {
      en: 'The five scores combined with the score weights of the row\'s archetype: a stable stock leans on Safety and Cheap, a growing one on Quality, a volatile one on Entry point. Empty scores are left out and the weights of the rest are scaled up, as long as at least half of the weight is present. The status compares this number with the thresholds of the archetype',
      ru: 'Пять оценок, сложенные с весами архетипа строки: у стабильной бумаги главный вес у «Безопасно» и «Дёшево», у растущей - у «Качественно», у волатильной - у «Точки входа». Пустые оценки не участвуют, веса остальных растягиваются, пока есть хотя бы половина веса. Статус сравнивает это число с порогами архетипа',
    },
  }),
  scoring({
    id: 'archetype', name: { en: 'Archetype', ru: 'Архетип' }, formula: 'first matching rule of the archetypeRules list in the config (preset conditions), else defaultArchetype: stable, growth or volatile',
    unit: 'category', basis: 'snapshot', source: 'computed', direction: 'neutral', appliesTo: BOTH,
    short: { en: 'Stable, growth or volatile: decides weights and stop factors', ru: 'Стабильная, растущая или волатильная: задаёт веса и стоп-факторы' },
    guide: {
      en: 'Every row gets one of three archetypes by an ordered list of rules in preset format, the first matching rule wins: volatile (volatility1y at least 45%), growth (revenue growing 15% a year over 3 years, or 25% in the last year while free cash flow is negative), stable (pays a dividend or volatility below 30%); without a match the default archetype. ETFs only meet the price rules. The archetype picks the metric weights, the score weights, the status thresholds and the stop factors',
      ru: 'Каждая строка получает один из трёх архетипов по упорядоченному списку правил в формате пресета, побеждает первое совпавшее: волатильная (volatility1y от 45%), растущая (выручка растёт на 15% в год за 3 года или на 25% за последний год при отрицательном свободном потоке), стабильная (платит дивиденд или волатильность ниже 30%); без совпадения - архетип по умолчанию. ETF попадают только под ценовые правила. Архетип выбирает веса метрик, веса оценок, пороги статуса и стоп-факторы',
    },
  }),
  scoring({
    id: 'status', name: { en: 'Status', ru: 'Статус' }, formula: 'rejected when a stop factor of the archetype fires, else buy when statusScore >= buy threshold, rejected when below the reject threshold, otherwise watch',
    unit: 'category', basis: 'snapshot', source: 'computed', direction: 'neutral', appliesTo: BOTH,
    nullWhen: { en: 'statusScore is empty and no stop factor fired', ru: 'итоговая оценка пуста и стоп-фактор не сработал' },
    short: { en: 'Buy zone, Watch or Rejected', ru: 'Зона покупки, Наблюдать или Отклонено' },
    guide: {
      en: 'Buy zone, Watch or Rejected (values buy, watch, rejected for presets). A stop factor of the archetype rejects the row whatever the scores say: Altman Z in the distress zone or negative free cash flow three years in a row for stable stocks, less than 12 months of cash for growing ones, Altman distress for volatile ones. Otherwise the status score decides against the thresholds of the archetype. The Why column says which rule decided',
      ru: 'Зона покупки, Наблюдать или Отклонено (в пресетах - значения buy, watch, rejected). Стоп-фактор архетипа отклоняет строку при любых оценках: Altman Z в зоне дистресса или отрицательный свободный поток три года подряд у стабильных, кэша меньше чем на 12 месяцев у растущих, дистресс по Altman у волатильных. Иначе решает итоговая оценка против порогов архетипа. Колонка «Почему» говорит, какое правило сработало',
    },
  }),
  scoring({
    id: 'why', name: { en: 'Why', ru: 'Почему' }, formula: 'archetype, the stop factor or the status rule, then the notes of the config whose condition holds, in the current language',
    unit: 'text', basis: 'snapshot', source: 'computed', direction: 'neutral', appliesTo: BOTH,
    short: { en: 'Short reasons behind the status', ru: 'Короткие причины статуса' },
    guide: {
      en: 'Short reasons in the current language, for example "Stable; score 72 >= 65; streak 12 years; -28% from 52W high" or "Growth; stop: cash runway 7 months < 12". The first item is the archetype, then the stop factor or the status rule, then the notes of the config whose condition holds (FCF payout above 70, a long streak, a deep drop from the high)',
      ru: 'Короткие причины на текущем языке, например «Стабильная; оценка 72 >= 65; стрик 12 лет; -28% от 52-нед. максимума» или «Растущая; стоп: запас кэша 7 мес. < 12». Сначала архетип, затем стоп-фактор или правило статуса, затем заметки конфига, условие которых выполнено (FCF payout выше 70, длинный стрик, глубокая просадка от максимума)',
    },
  }),
  scoring({
    id: 'flags', name: { en: 'Flags', ru: 'Флаги' }, formula: 'ids of the flags of the config whose rule holds, in config order',
    unit: 'text', basis: 'snapshot', source: 'computed', direction: 'neutral',
    short: { en: 'Red flags in the reports', ru: 'Красные флаги в отчётности' },
    guide: {
      en: 'Warnings read from the reports, each a rule in preset format with thresholds in the config: net income grows while operating cash flow does not (the main red flag), the operating margin falls while revenue grows, debt to equity above 2, EPS grows notably faster than net income (buybacks), free cash flow far below net income (a capex phase), a large year-over-year change of a balance line. A flag is a reason to read the reports, not a verdict; it does not change the status',
      ru: 'Предупреждения из отчётности, каждое - правило в формате пресета с порогами в конфиге: чистая прибыль растёт, а операционный поток нет (главный красный флаг), операционная маржа падает при растущей выручке, долг к капиталу выше 2, EPS растёт заметно быстрее чистой прибыли (выкуп), свободный поток намного ниже прибыли (фаза capex), крупное изменение строки баланса год к году. Флаг - повод прочитать отчёт, а не приговор; на статус он не влияет',
    },
  }),
  scoring({
    id: 'flagCount', name: { en: 'Number of flags', ru: 'Число флагов' }, formula: 'number of flags that fire',
    unit: 'count', basis: 'snapshot', source: 'computed', direction: 'lower-is-better',
    short: { en: 'How many red flags fire', ru: 'Сколько красных флагов сработало' },
    guide: {
      en: 'The number of flags of the config that fire for the stock, 0 when none does. A preset condition such as flagCount = 0 keeps only clean reports; sort by it to see the stocks that need a closer look first',
      ru: 'Число сработавших флагов конфига, 0 если нет ни одного. Условие пресета flagCount = 0 оставляет только чистую отчётность; сортировка по нему показывает бумаги, которые надо проверить первыми',
    },
  }),
];

const SCORE_INPUTS: MetricDef[] = [
  def({
    id: 'dividendStreak', name: { en: 'Dividend increase streak', ru: 'Стрик повышений дивиденда' }, formula: 'complete calendar years in a row whose dividend per share is above the base year (the year before, or the one before a special dividend), counted back from the last complete year (market.annualDps, up to 15 years)',
    unit: 'count', basis: 'calendar-year', source: 'yahoo-chart', direction: 'higher-is-better', thresholds: { good: 10 },
    nullWhen: { en: 'no dividend in the last complete calendar year', ru: 'нет дивиденда в последнем полном календарном году' },
    short: { en: 'Years in a row with a higher dividend', ru: 'Лет подряд с повышением дивиденда' },
    guide: {
      en: 'How many complete calendar years in a row the dividend per share (split adjusted, sum of the ex-dates of the year) went up. A flat year ends the streak. A special dividend does not count: a year more than 1.2 times above both neighbours is skipped as the base. The feed keeps up to 15 years, so the streak tops out at 14 even for a company raising for 60 years. 10 and more is a dividend grower',
      ru: 'Сколько полных календарных лет подряд дивиденд на акцию (с поправкой на сплиты, сумма экс-дат года) повышался. Год без изменений обрывает стрик. Спецдивиденд не считается: год, который больше обоих соседей в 1,2 раза, пропускается как база. Фид хранит до 15 лет, поэтому стрик не больше 14 даже у компании, повышающей выплату 60 лет. От 10 лет - устойчивый растущий плательщик',
    },
  }),
  def({
    id: 'dividendCut10y', name: { en: 'Dividend cut in 10 years', ru: 'Сокращение дивиденда за 10 лет' }, formula: 'true when a complete calendar year of the last 10 paid more than 10% less than its base year and the next year did not come back; a stopped dividend is a cut',
    unit: 'flag', basis: 'calendar-year', source: 'yahoo-chart', direction: 'neutral',
    nullWhen: { en: 'no dividend in the last 11 complete calendar years', ru: 'нет дивидендов за последние 11 полных календарных лет' },
    short: { en: 'Did the company cut its dividend in 10 years', ru: 'Сокращала ли компания дивиденд за 10 лет' },
    guide: {
      en: 'True when the dividend per share of a calendar year fell more than 10% below its base year (the year before, or the one before a special dividend) and the next year did not return to the base, so a December payment moved into January is not a cut. A suspension is a cut. The last complete year has no next year yet and can show a shifted payment as a cut; check recentDividends then. Drops under 10% (rounding, currency of ADRs) are ignored',
      ru: 'Истина, если дивиденд на акцию календарного года упал больше чем на 10% ниже базового года (предыдущего или года перед спецдивидендом), а следующий год не вернулся к базе, поэтому платёж, сдвинутый с декабря на январь, - не сокращение. Приостановка - сокращение. У последнего полного года следующего ещё нет, и сдвинутый платёж может выглядеть сокращением; тогда смотрите recentDividends. Падения меньше 10% (округление, валюта ADR) не учитываются',
    },
  }),
  def({
    id: 'fcfNegativeYears', name: { en: 'Negative FCF years in a row', ru: 'Лет подряд с отрицательным FCF' }, formula: 'fiscal years in a row, counted back from the latest, with operating cash flow - capex < 0 (SEC 10-K)',
    unit: 'count', basis: 'fy', source: 'sec', direction: 'lower-is-better', thresholds: { good: 0, bad: 3 }, sectorNotes: FIN_EMPTY,
    nullWhen: { en: 'the latest fiscal year has no operating cash flow or capex', ru: 'у последнего финансового года нет операционного потока или капзатрат' },
    short: { en: 'Fiscal years in a row of cash burn', ru: 'Финансовых лет подряд со сжиганием денег' },
    guide: {
      en: 'How many fiscal years in a row, back from the latest 10-K, free cash flow (operating cash flow minus capital expenditures) was negative; 0 when the latest year is positive. Three or more is the stop factor of the stable archetype: a mature company that burns cash for three years lives on debt or new shares',
      ru: 'Сколько финансовых лет подряд, считая от последнего 10-K, свободный поток (операционный поток минус капзатраты) был отрицательным; 0, если последний год положительный. Три и больше - стоп-фактор стабильного архетипа: зрелая компания, сжигающая деньги три года, живёт на долг или новые акции',
    },
  }),
  def({
    id: 'cfoGrowth3y', name: { en: 'Operating cash flow growth 3Y CAGR', ru: 'Рост операционного потока, CAGR 3 года' }, formula: 'CAGR of operating cash flow from the fiscal year 3 years before the latest (SEC 10-K)',
    unit: 'percent', basis: 'fy', source: 'sec', direction: 'higher-is-better',
    nullWhen: { en: 'an endpoint is not positive or missing', ru: 'одна из точек не положительна или отсутствует' },
    short: { en: 'Yearly growth of operating cash flow over 3 years', ru: 'Годовой рост операционного потока за 3 года' },
    guide: {
      en: 'Compound yearly growth of the operating cash flow over the latest 3 fiscal years. Read next to niGrowth3y: profit that grows while the cash it brings does not is the main red flag of the reports (receivables or inventories swelling, aggressive revenue recognition)',
      ru: 'Среднегодовой рост операционного денежного потока за последние 3 финансовых года. Читается рядом с niGrowth3y: прибыль растёт, а деньги от неё нет - главный красный флаг отчётности (растут дебиторка или запасы, агрессивное признание выручки)',
    },
  }),
  def({
    id: 'epsNiGrowthGap3y', name: { en: 'EPS over net income growth 3Y', ru: 'Опережение EPS над прибылью за 3 года' }, formula: 'CAGR of diluted EPS over 3 fiscal years - niGrowth3y, percentage points (SEC 10-K, split restated)',
    unit: 'pp', basis: 'fy', source: 'sec', direction: 'neutral',
    nullWhen: { en: 'one of the two CAGRs is empty (an endpoint not positive)', ru: 'один из двух CAGR пуст (точка не положительна)' },
    short: { en: 'How much faster EPS grows than net income', ru: 'Насколько EPS растёт быстрее чистой прибыли' },
    guide: {
      en: 'Yearly EPS growth minus yearly net income growth over 3 fiscal years. A positive gap means the share count fell: buybacks lift EPS without the business growing as fast. A few points are normal for a buyback programme; a large gap means the EPS story is mostly buybacks, often paid with debt',
      ru: 'Годовой рост EPS минус годовой рост чистой прибыли за 3 финансовых года. Положительный разрыв значит, что акций стало меньше: выкуп поднимает EPS без такого же роста бизнеса. Несколько пунктов - норма для программы выкупа; большой разрыв значит, что рост EPS держится на выкупе, часто в долг',
    },
  }),
  def({
    id: 'balanceYoyMaxChange', name: { en: 'Largest balance line change YoY', ru: 'Крупнейшее изменение строки баланса за год' }, formula: 'largest by absolute value of (line FY0 / line FY-1 - 1) × 100 over cash, receivables, current assets, assets, current liabilities, liabilities, debt, equity; a line counts when FY-1 is at least 10% of FY-1 assets',
    unit: 'percent', basis: 'fy', source: 'sec', direction: 'neutral',
    nullWhen: { en: 'fewer than two fiscal years or no material line', ru: 'меньше двух финансовых лет или нет существенной строки' },
    short: { en: 'Biggest jump of a balance line in a year', ru: 'Самый большой скачок строки баланса за год' },
    guide: {
      en: 'The balance sheet line that moved the most between the last two fiscal year ends, in percent, with its name in balanceYoyMaxLine. Small lines (under 10% of the assets of the year before) are ignored, so a cash pile going from 1% to 3% of assets does not count. A large jump comes from an acquisition, a big loan, a write-off or a buyback in debt: read the 10-K before trusting the other metrics',
      ru: 'Строка баланса, которая сильнее всего изменилась между двумя последними концами финансового года, в процентах, её имя - в balanceYoyMaxLine. Мелкие строки (меньше 10% активов предыдущего года) не учитываются, поэтому рост кэша с 1% до 3% активов не считается. Крупный скачок дают поглощение, большой кредит, списание или выкуп в долг: прочитайте 10-K, прежде чем доверять остальным метрикам',
    },
  }),
  def({
    id: 'balanceYoyMaxLine', name: { en: 'Line of the largest balance change', ru: 'Строка крупнейшего изменения баланса' }, formula: 'name of the line behind balanceYoyMaxChange: cash, receivables, currentAssets, assets, currentLiabilities, liabilities, debt or equity',
    unit: 'category', basis: 'fy', source: 'sec', direction: 'neutral',
    nullWhen: { en: 'balanceYoyMaxChange is empty', ru: 'balanceYoyMaxChange пуст' },
    short: { en: 'Which balance line moved the most', ru: 'Какая строка баланса изменилась сильнее всего' },
    guide: {
      en: 'The SEC field name of the balance line with the largest year-over-year change: cash, receivables, currentAssets, assets, currentLiabilities, liabilities, debt or equity. The flag text of a large balance change shows it, for example "debt +100% YoY"',
      ru: 'Имя поля SEC строки баланса с самым большим изменением за год: cash, receivables, currentAssets, assets, currentLiabilities, liabilities, debt или equity. Текст флага крупного изменения баланса показывает его, например «debt +100% за год»',
    },
  }),
  def({
    id: 'revenueGrowthVsTam', name: { en: 'Revenue growth vs market (TAM)', ru: 'Рост выручки против рынка (TAM)' }, formula: 'revenueGrowth3y - yearly growth of the total addressable market from user-data/tam/<T>.json, percentage points',
    unit: 'pp', basis: 'fy', source: 'planned', direction: 'higher-is-better',
    nullWhen: { en: 'no TAM file for the ticker (not computed yet)', ru: 'нет файла TAM для тикера (пока не считается)' },
    short: { en: 'Does revenue outgrow its market', ru: 'Растёт ли выручка быстрее своего рынка' },
    guide: {
      en: 'Planned: revenue growth over 3 years minus the yearly growth of the market the company sells into, taken from the owner\'s TAM file user-data/tam/<T>.json. Below 0 the company loses share, which is the flag "revenue grows slower than the market". The flag is in the config but switched off until TAM files exist',
      ru: 'Запланировано: рост выручки за 3 года минус годовой рост рынка, на котором продаёт компания, из файла TAM владельца user-data/tam/<T>.json. Ниже 0 компания теряет долю - это флаг «выручка растёт медленнее рынка». Флаг есть в конфиге, но выключен, пока нет файлов TAM',
    },
  }),
];

const BASE: MetricDef[] = [...MARKET, ...VALUATION, ...DIVIDENDS, ...BALANCE, ...GROWTH, ...MARGINS, ...PERFORMANCE, ...TOTAL_RETURN, ...META, ...SWINGS, ...SEC_DERIVED, ...FOREIGN, ...PLANNED, ...SCORE_INPUTS, ...FIELDS, ...SCORE_OUTPUTS];

const textCompanion = (base: MetricDef): MetricDef => def({
  id: `${base.id}Text`, name: { en: `${base.name.en} (text)`, ru: `${base.name.ru} (текст)` }, formula: `issuer display text of ${base.id}`,
  unit: 'text', basis: 'meta', source: 'issuer', direction: 'neutral', appliesTo: ETF,
  short: { en: `${base.name.en} as the issuer writes it`, ru: `${base.name.ru} в написании эмитента` },
  guide: {
    en: `The display text of ${base.id} exactly as the issuer publishes it, for example 4.25% or N/A. The screener filters on the number ${base.id}; the text keeps the issuer's formatting and notes. ${base.short.en}`,
    ru: `Текст значения ${base.id} ровно так, как его публикует эмитент, например 4.25% или N/A. Скринер фильтрует по числу ${base.id}, а текст сохраняет оформление и пометки эмитента. ${base.short.ru}`,
  },
});

export const METRICS: MetricDef[] = BASE.concat(TEXT_COMPANIONS.map((id) => {
  const base = BASE.filter((m) => m.id === id)[0];
  if (!base) throw new Error(`text companion without a base metric: ${id}`);
  return textCompanion(base);
}));
