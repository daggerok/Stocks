/// <reference lib="esnext" />
/**
 * The metric registry: one entry for every key of `metrics` in the Stocks feed and the 29 ETF brand feeds, the screener's
 * row fields and the metrics presets already reference before the updater publishes them (`source: 'planned'`).
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
    id: 'enterpriseValue', name: { en: 'Enterprise value', ru: 'Стоимость компании (EV)' }, formula: 'market cap + debt - cash (Yahoo quoteSummary enterpriseValue)',
    unit: 'usd', basis: 'snapshot', source: 'yahoo-summary', direction: 'neutral', nullWhen: ADR_NULL,
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
    id: 'pe', name: { en: 'P/E (TTM)', ru: 'P/E (TTM)' }, formula: 'price / diluted EPS of the trailing twelve months (Yahoo trailingPE)',
    unit: 'ratio', basis: 'ttm', source: 'yahoo-summary', direction: 'lower-is-better', thresholds: { good: 15, bad: 30 }, nullWhen: { en: 'the company has a loss (EPS not positive) or ' + ADR_NULL.en, ru: 'у компании убыток (EPS не положителен) или ' + ADR_NULL.ru },
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
    id: 'ps', name: { en: 'P/S (TTM)', ru: 'P/S (TTM)' }, formula: 'market cap / revenue of the trailing twelve months (Yahoo priceToSalesTrailing12Months)',
    unit: 'ratio', basis: 'ttm', source: 'yahoo-summary', direction: 'lower-is-better', thresholds: { good: 2, bad: 10 }, nullWhen: ADR_NULL,
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
    id: 'pFcf', name: { en: 'P/FCF', ru: 'P/FCF' }, formula: 'market cap / free cash flow of the trailing twelve months (Yahoo financialData.freeCashflow)',
    unit: 'ratio', basis: 'ttm', source: 'computed', direction: 'lower-is-better', thresholds: { good: 15, bad: 30 }, nullWhen: { en: 'free cash flow is not positive or ' + ADR_NULL.en, ru: 'свободный денежный поток не положителен или ' + ADR_NULL.ru }, sectorNotes: FIN_NOTE,
    short: { en: 'Price over a year of free cash flow', ru: 'Цена к годовому свободному денежному потоку' },
    guide: {
      en: 'P/FCF divides the market cap by the free cash flow of the last twelve months (Yahoo). Cash is harder to dress up than earnings, so a low P/FCF next to a high P/E often means accounting charges, and the reverse means heavy investment. Below 15 is cheap, above 30 expensive for a mature company. Empty when FCF is zero or negative',
      ru: 'P/FCF делит капитализацию на свободный денежный поток за последние двенадцать месяцев (Yahoo). Деньги труднее приукрасить, чем прибыль, поэтому низкий P/FCF при высоком P/E часто означает бумажные списания, а обратная картина - большие инвестиции. Ниже 15 - дёшево, выше 30 - дорого для зрелой компании. Пусто при нулевом или отрицательном FCF',
    },
  }),
  def({
    id: 'evEbitda', name: { en: 'EV/EBITDA', ru: 'EV/EBITDA' }, formula: 'enterprise value / EBITDA of the trailing twelve months (Yahoo enterpriseToEbitda)',
    unit: 'ratio', basis: 'ttm', source: 'yahoo-summary', direction: 'lower-is-better', thresholds: { good: 10, bad: 20 }, nullWhen: { en: 'EBITDA is not positive or ' + ADR_NULL.en, ru: 'EBITDA не положительна или ' + ADR_NULL.ru }, sectorNotes: FIN_NOTE,
    short: { en: 'Business price over operating cash earnings', ru: 'Цена бизнеса к операционной прибыли до амортизации' },
    guide: {
      en: 'EV/EBITDA compares the price of the whole business, debt included, with its earnings before interest, taxes, depreciation and amortization. It is neutral to capital structure, so it compares companies with different debt better than P/E. Below 10 is usually cheap, above 20 expensive. The value currently uses Yahoo\'s EBITDA, which can differ from the EBITDA of ebitdaMargin',
      ru: 'EV/EBITDA сравнивает цену всего бизнеса вместе с долгом с прибылью до процентов, налогов и амортизации. Метрика не зависит от структуры капитала и поэтому лучше P/E сравнивает компании с разным долгом. Ниже 10 обычно дёшево, выше 20 - дорого. Сейчас берётся EBITDA из Yahoo, она может отличаться от EBITDA в ebitdaMargin',
    },
  }),
  def({
    id: 'fcfToEbitda', name: { en: 'FCF / EBITDA', ru: 'FCF / EBITDA' }, formula: 'free cash flow / EBITDA × 100, both TTM from Yahoo',
    unit: 'percent', basis: 'ttm', source: 'computed', direction: 'higher-is-better', thresholds: { good: 60 }, nullWhen: { en: 'EBITDA is not positive or a value is missing', ru: 'EBITDA не положительна или нет одного из значений' }, sectorNotes: FIN_NOTE,
    short: { en: 'Share of EBITDA that turns into free cash', ru: 'Какая доля EBITDA превращается в свободные деньги' },
    guide: {
      en: 'Cash conversion: how much of EBITDA is left as free cash flow after interest, taxes, working capital and capital spending. Above 60% is a cash machine, below 30% means heavy investment or high interest. A negative value means the company burns cash despite positive EBITDA',
      ru: 'Конверсия в деньги: сколько EBITDA остаётся свободным денежным потоком после процентов, налогов, оборотного капитала и капзатрат. Выше 60% - денежная машина, ниже 30% - большие инвестиции или высокие проценты. Отрицательное значение означает, что компания сжигает деньги при положительной EBITDA',
    },
  }),
  def({
    id: 'pb', name: { en: 'P/B', ru: 'P/B' }, formula: 'price / book value per share (Yahoo priceToBook)',
    unit: 'ratio', basis: 'snapshot', source: 'yahoo-summary', direction: 'lower-is-better', thresholds: { good: 1.5, bad: 5 }, nullWhen: { en: 'book value is not positive or ' + ADR_NULL.en, ru: 'балансовый капитал не положителен или ' + ADR_NULL.ru },
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
    sectorNotes: { en: 'REITs and MLPs pay out most of their cash by design and look over 100% on net income; the planned approximate FFO payout replaces it for REITs', ru: 'REIT и MLP по устройству раздают почти все деньги и на чистой прибыли выглядят выше 100%; для REIT его заменит запланированный payout от приблизительного FFO' },
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
    id: 'netDebtToEbitda', name: { en: 'Net debt / EBITDA', ru: 'Чистый долг / EBITDA' }, formula: '(debt - cash and short-term investments - long-term investments) / EBITDA, latest fiscal year',
    unit: 'ratio', basis: 'fy', source: 'sec', direction: 'lower-is-better', thresholds: { good: 2.5, bad: 3 },
    nullWhen: { en: 'EBITDA is zero or negative or a value is missing', ru: 'EBITDA нулевая или отрицательная либо нет значения' }, sectorNotes: FIN_NOTE,
    short: { en: 'Years of EBITDA needed to repay net debt', ru: 'За сколько лет EBITDA погасит чистый долг' },
    guide: {
      en: 'Debt minus cash and investments, divided by the EBITDA of the latest fiscal year (operating income plus depreciation and amortization from the 10-K). A negative value means more cash than debt. Below 2.5 is safe, above 3 is high for most industries. It reads better than debt to equity when buybacks have wiped out equity',
      ru: 'Долг минус кэш и вложения, делённый на EBITDA последнего финансового года (операционная прибыль плюс амортизация из 10-K). Отрицательное значение - денег больше, чем долга. Ниже 2,5 - безопасно, выше 3 - много для большинства отраслей. Метрика понятнее долга к капиталу, когда выкупы обнулили капитал',
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
  id, name: { en: id === 'perf1y' ? 'Return 1Y (price)' : `Performance ${en}`, ru: id === 'perf1y' ? 'Доходность за год (цена)' : `Изменение цены за ${ru}`.replace('за с начала', 'с начала') },
  formula: `last close / ${anchorEn} - 1, × 100, unadjusted closes`, unit: 'percent', basis: 'price', source: 'yahoo-chart', direction: 'higher-is-better',
  nullWhen: { en: 'the price history does not reach back to the anchor date', ru: 'история цен не доходит до опорной даты' },
  short: { en: `Price change ${({ WTD: 'week to date', MTD: 'month to date', QTD: 'quarter to date', YTD: 'year to date' } as Record<string, string>)[en] ?? `over ${en}`}, without dividends`, ru: `Изменение цены за ${ru} без дивидендов`.replace('за с начала', 'с начала') },
  guide: {
    en: `Cumulative price change from ${anchorEn} to the last close, on unadjusted closes up to performanceAsOf, so dividends are not included (total return is in the tr columns). ${['perf1d', 'perf3d', 'perf1w', 'perf2w', 'perf20d', 'perf40d', 'perf60d'].indexOf(id) >= 0 ? 'Short windows count daily candles and depend on the date of the last candle: a stock whose performanceAsOf lags measures a different window' : 'Calendar windows anchor on dates, so stocks with the same performanceAsOf are compared on the same period'}. ${id === 'perf1y' ? 'This is the plan\'s "return for the year" metric of the stable and gold selections. ' : ''}Momentum readers look for strength over 6-12 months, buy-low investors for pullbacks`,
    ru: `Накопленное изменение цены между ${anchorRu} и последним закрытием, по закрытиям без поправок до даты performanceAsOf, поэтому дивиденды не учтены (полная доходность - в колонках tr). ${['perf1d', 'perf3d', 'perf1w', 'perf2w', 'perf20d', 'perf40d', 'perf60d'].indexOf(id) >= 0 ? 'Короткие окна считают дневные свечи и зависят от даты последней свечи: бумага с отстающим performanceAsOf меряет другое окно' : 'Календарные окна привязаны к датам, поэтому бумаги с одинаковым performanceAsOf сравниваются на одном периоде'}. ${id === 'perf1y' ? 'Это метрика «Доходность за год» из плана, её используют выборки по растущим бумагам и золоту. ' : ''}Кто следует за импульсом, ищет силу за 6-12 месяцев, кто добирает ниже - откаты`,
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
    en: `Total return ${spanEn}: price change plus reinvested dividends. Stocks use dividend and split-adjusted closes of the Yahoo chart; ETFs carry the issuer's official NAV total return where the brand publishes it, else a figure derived from Yahoo, and returnsBasis says which. ${annual ? 'The annualized rate compares horizons of different length; 7-10% a year is the long-run equity average' : 'A cumulative figure: divide by the years only roughly, the CAGR columns do it exactly'}`,
    ru: `Полная доходность ${spanRu}: изменение цены плюс реинвестированные дивиденды. У акций - по закрытиям графика Yahoo с поправкой на дивиденды и сплиты; у ETF - официальная доходность по NAV от эмитента, если бренд её публикует, иначе расчёт по Yahoo, и returnsBasis говорит, что именно. ${annual ? 'Годовой темп позволяет сравнивать горизонты разной длины; 7-10% в год - долгосрочное среднее для акций' : 'Это накопленная величина: делить её на число лет можно лишь грубо, точно это делают колонки CAGR'}`,
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
// planned metrics (plan stage 1.5): presets reference them already; the engine reports them as unavailable until published

const PLANNED: MetricDef[] = [
  def({
    id: 'peg', name: { en: 'PEG ratio', ru: 'PEG' }, formula: 'forward P/E / consensus EPS growth for 5 years in % (fallback: next-year growth)', unit: 'ratio', basis: 'forward', source: 'planned', direction: 'lower-is-better', thresholds: { good: 1 },
    nullWhen: { en: 'a loss or expected growth of zero or less', ru: 'убыток или ожидаемый рост не больше нуля' },
    short: { en: 'Forward P/E per point of expected growth', ru: 'Форвардный P/E на процент ожидаемого роста' },
    guide: {
      en: 'PEG divides the forward P/E by the expected yearly EPS growth in percent: the analysts\' 5-year consensus, or the next-year growth when the 5-year figure is missing (the source will be shown in the tooltip). Around 1 or below means the growth is not overpriced, above 2 is expensive. Forecasts are optimistic on average, so pegHist on historical growth is the cross-check',
      ru: 'PEG делит форвардный P/E на ожидаемый годовой рост EPS в процентах: консенсус аналитиков на 5 лет, а если его нет - рост следующего года (источник будет в подсказке). Около 1 и ниже - рост не переоценён, выше 2 - дорого. Прогнозы в среднем оптимистичны, поэтому для проверки служит pegHist на историческом росте',
    },
  }),
  def({
    id: 'forwardToTtmPe', name: { en: 'Forward to TTM P/E', ru: 'Форвардный P/E к P/E TTM' }, formula: 'forwardPe / pe', unit: 'ratio', basis: 'forward', source: 'planned', direction: 'lower-is-better', thresholds: { good: 1 },
    nullWhen: { en: 'either P/E is empty', ru: 'один из P/E пуст' },
    short: { en: 'Below 1 when earnings are expected to grow', ru: 'Ниже 1, когда ждут роста прибыли' },
    guide: {
      en: 'The forward P/E divided by the trailing P/E. Below 1 the market expects higher earnings next year, above 1 lower ones. It turns the comparison of two metrics into one metric, which is how the screener expresses "forward P/E below TTM P/E"',
      ru: 'Форвардный P/E, делённый на P/E TTM. Ниже 1 - рынок ждёт роста прибыли в следующем году, выше 1 - снижения. Метрика превращает сравнение двух метрик в одну, так скринер выражает условие «форвардный P/E ниже P/E TTM»',
    },
  }),
  def({
    id: 'pePct5y', name: { en: 'P/E percentile in 5 years', ru: 'Перцентиль P/E за 5 лет' }, formula: 'share of monthly P/E values of the last 5 years below the current one × 100', unit: 'percent', basis: 'history', source: 'planned', direction: 'lower-is-better', thresholds: { good: 50 },
    nullWhen: { en: 'less than 5 years of history or a loss', ru: 'меньше 5 лет истории или убыток' },
    short: { en: 'Where today\'s P/E sits in its own 5-year history', ru: 'Где текущий P/E в собственной истории за 5 лет' },
    guide: {
      en: 'The percentile of the current P/E within the company\'s own monthly P/E series of the last five years (monthly prices over the TTM earnings of each date), computed by the updater. 0 is the cheapest in five years, 100 the most expensive. Below 50 means cheaper than usual for this company, whatever its sector. Presets read it with scope history',
      ru: 'Перцентиль текущего P/E в собственном месячном ряду P/E компании за пять лет (месячные цены к TTM-прибыли на каждую дату), считается апдейтером. 0 - дешевле всего за пять лет, 100 - дороже всего. Ниже 50 - дешевле обычного для этой компании, независимо от сектора. Пресеты читают его со scope history',
    },
  }),
  def({
    id: 'pFcfPct5y', name: { en: 'P/FCF percentile in 5 years', ru: 'Перцентиль P/FCF за 5 лет' }, formula: 'share of monthly P/FCF values of the last 5 years below the current one × 100', unit: 'percent', basis: 'history', source: 'planned', direction: 'lower-is-better', thresholds: { good: 50 },
    nullWhen: { en: 'less than 5 years of history or FCF not positive', ru: 'меньше 5 лет истории или FCF не положителен' },
    short: { en: 'Where today\'s P/FCF sits in its own 5-year history', ru: 'Где текущий P/FCF в собственной истории за 5 лет' },
    guide: {
      en: 'Like pePct5y, but for price to free cash flow: the percentile of today\'s P/FCF within the company\'s own monthly series of five years. It helps with companies whose earnings are distorted by non-cash charges. Low values mean the cash flow is cheap by the company\'s own standards',
      ru: 'Как pePct5y, но для цены к свободному денежному потоку: перцентиль текущего P/FCF в собственном месячном ряду компании за пять лет. Помогает там, где прибыль искажена неденежными списаниями. Низкие значения - денежный поток дёшев по меркам самой компании',
    },
  }),
  def({
    id: 'yieldVsAvg5y', name: { en: 'Yield vs 5-year average', ru: 'Доходность к средней за 5 лет' }, formula: 'dividend yield / its 5-year average yield', unit: 'ratio', basis: 'history', source: 'planned', direction: 'higher-is-better',
    nullWhen: { en: 'no dividend or less than 5 years of history', ru: 'нет дивиденда или меньше 5 лет истории' },
    short: { en: 'Above 1 when the yield is higher than usual', ru: 'Выше 1, когда доходность выше обычной' },
    guide: {
      en: 'The current dividend yield divided by the average yield of the last five years, computed by the updater. Above 1 the stock pays more than usual for its price, a classic buy signal for stable dividend payers; check that the dividend itself is safe, since a yield spike can precede a cut',
      ru: 'Текущая дивидендная доходность, делённая на среднюю доходность за пять лет, считается апдейтером. Выше 1 - бумага платит больше обычного относительно цены, классический сигнал покупки для стабильных плательщиков; при этом проверяют надёжность дивиденда, потому что всплеск доходности может предшествовать сокращению',
    },
  }),
  def({
    id: 'operatingMarginSlope3y', name: { en: 'Operating margin trend 3Y', ru: 'Тренд операционной маржи за 3 года' }, formula: 'slope of a linear fit over 4 annual operating margins, percentage points per year', unit: 'pp', basis: 'fy', source: 'planned', direction: 'higher-is-better', thresholds: { good: 0 },
    nullWhen: { en: 'fewer than 4 annual points', ru: 'меньше 4 годовых точек' },
    short: { en: 'Yearly change of the operating margin trend', ru: 'Годовое изменение тренда операционной маржи' },
    guide: {
      en: 'The slope of a straight line fitted through the operating margins of the last four fiscal years, in percentage points per year. A positive slope means the business gets more profitable as it grows; unlike a two-point delta it is not thrown off by one odd year',
      ru: 'Наклон прямой, проведённой через операционные маржи последних четырёх финансовых лет, в процентных пунктах за год. Положительный наклон - бизнес становится рентабельнее по мере роста; в отличие от разницы двух точек одна странная годовая точка его не сбивает',
    },
  }),
  def({
    id: 'niVolatility5y', name: { en: 'Net income volatility 5Y', ru: 'Волатильность чистой прибыли за 5 лет' }, formula: 'standard deviation of yearly net income growth rates over 5 years, percentage points', unit: 'pp', basis: 'fy', source: 'planned', direction: 'lower-is-better', thresholds: { good: 25 },
    nullWhen: { en: 'fewer than 6 annual points with a positive base', ru: 'меньше 6 годовых точек с положительной базой' },
    short: { en: 'How uneven profit growth has been', ru: 'Насколько неровно росла прибыль' },
    guide: {
      en: 'The standard deviation of the yearly growth rates of net income over five years, in percentage points; it needs six annual points with a positive base. Low values mark predictable earnings, the trait of stable compounders. The starting threshold of the undervalued preset is 25 and will be tuned after the first real runs',
      ru: 'Стандартное отклонение годовых темпов роста чистой прибыли за пять лет в процентных пунктах; нужно шесть годовых точек с положительной базой. Низкие значения - предсказуемая прибыль, черта стабильных компаний. Стартовый порог пресета «Недооценённые» - 25, он будет подстроен после первых реальных прогонов',
    },
  }),
  def({
    id: 'fcfVolatility5y', name: { en: 'FCF volatility 5Y', ru: 'Волатильность FCF за 5 лет' }, formula: 'standard deviation of yearly FCF growth rates over 5 years, percentage points', unit: 'pp', basis: 'fy', source: 'planned', direction: 'lower-is-better', thresholds: { good: 30 },
    nullWhen: { en: 'fewer than 6 annual points with a positive base', ru: 'меньше 6 годовых точек с положительной базой' },
    short: { en: 'How uneven free cash flow growth has been', ru: 'Насколько неровно рос свободный денежный поток' },
    guide: {
      en: 'The standard deviation of the yearly growth rates of free cash flow over five years, in percentage points. FCF is naturally lumpier than earnings because capital spending comes in waves, so its threshold is looser. Very high values mean the cash flow cannot be extrapolated',
      ru: 'Стандартное отклонение годовых темпов роста свободного денежного потока за пять лет в процентных пунктах. FCF от природы неровнее прибыли, потому что капзатраты идут волнами, поэтому порог мягче. Очень высокие значения означают, что денежный поток нельзя экстраполировать',
    },
  }),
  def({
    id: 'cfoToNi', name: { en: 'Cash conversion (CFO / NI)', ru: 'Конверсия в деньги (CFO / NI)' }, formula: 'operating cash flow / net income, TTM', unit: 'ratio', basis: 'ttm', source: 'planned', direction: 'neutral', thresholds: { good: 1 },
    nullWhen: { en: 'net income is zero or negative', ru: 'чистая прибыль нулевая или отрицательная' },
    short: { en: 'Operating cash per dollar of reported profit', ru: 'Операционные деньги на доллар отчётной прибыли' },
    guide: {
      en: 'Operating cash flow divided by net income. Between 0.8 and 1.5 earnings are backed by cash. Persistently below 0.8 means profits sit in receivables or inventory, the main red flag of the plan ("net income grows, cash flow does not"); far above 1.5 usually means large non-cash charges',
      ru: 'Операционный денежный поток, делённый на чистую прибыль. От 0,8 до 1,5 прибыль подкреплена деньгами. Устойчиво ниже 0,8 - прибыль оседает в дебиторке или запасах, это главный красный флаг плана («прибыль растёт, денежный поток нет»); намного выше 1,5 - обычно большие неденежные списания',
    },
  }),
  def({
    id: 'capexToRevenueDelta3y', name: { en: 'CapEx intensity change 3Y', ru: 'Изменение доли капзатрат за 3 года' }, formula: 'capex / revenue now - capex / revenue 3 fiscal years earlier, percentage points', unit: 'pp', basis: 'fy', source: 'planned', direction: 'lower-is-better', thresholds: { good: 0 },
    nullWhen: { en: 'revenue or capex is missing for an endpoint', ru: 'нет выручки или капзатрат в одной из крайних точек' },
    short: { en: 'Change of capital spending as a share of revenue', ru: 'Изменение капзатрат как доли выручки' },
    guide: {
      en: 'Capital expenditures as a share of revenue today minus the same share three fiscal years earlier, in percentage points. Zero or below means growth does not need ever more investment, which is what the cash-flow machines preset wants. A rising share can be a deliberate build-out; read it together with revenue growth',
      ru: 'Доля капзатрат в выручке сейчас минус та же доля три финансовых года назад, в процентных пунктах. Ноль и ниже - росту не нужно всё больше вложений, именно этого ждёт пресет «Кэшфлоу-машины». Растущая доля может быть сознательной стройкой; её читают вместе с ростом выручки',
    },
  }),
  def({
    id: 'volatility1y', name: { en: 'Volatility 1Y', ru: 'Волатильность за год' }, formula: 'standard deviation of daily log returns over one year × √252 × 100', unit: 'percent', basis: 'price', source: 'planned', direction: 'neutral', appliesTo: BOTH, thresholds: { good: 45 },
    nullWhen: { en: 'less than a year of daily closes', ru: 'меньше года дневных закрытий' },
    short: { en: 'Annualized size of daily price swings', ru: 'Размер дневных колебаний цены в годовом выражении' },
    guide: {
      en: 'The standard deviation of daily log returns over the last year, annualized with √252, in percent. Broad index funds sit near 15%, large stable stocks at 20-30%, swing candidates at 45% and more. Higher volatility means wider swings to trade, and wider losses if the thesis is wrong',
      ru: 'Стандартное отклонение дневных логарифмических доходностей за последний год, приведённое к году через √252, в процентах. Широкие индексные фонды - около 15%, крупные стабильные акции - 20-30%, кандидаты для свинга - от 45%. Чем выше волатильность, тем шире размах для торговли и тем больше потери, если тезис неверен',
    },
  }),
  def({
    id: 'pctFromAth', name: { en: 'Distance from all-time high', ru: 'Отклонение от исторического максимума' }, formula: '(last close / highest split-adjusted close ever - 1) × 100', unit: 'percent', basis: 'price', source: 'planned', direction: 'neutral', appliesTo: BOTH, thresholds: { good: -30 },
    nullWhen: { en: 'no price history', ru: 'нет истории цен' },
    short: { en: 'How far below its record close the price is', ru: 'Насколько цена ниже рекордного закрытия' },
    guide: {
      en: 'The last close relative to the highest close ever, split adjusted but not dividend adjusted, in percent: 0 at a record, -30 means 30% below it. Buy-low investors look for deep drawdowns in healthy businesses, and the all-time high is a natural exit target for the swing preset',
      ru: 'Последнее закрытие относительно самого высокого закрытия за всю историю с поправкой на сплиты, но не на дивиденды, в процентах: 0 - на рекорде, -30 - на 30% ниже. Кто добирает ниже, ищет глубокие просадки у здоровых компаний, а исторический максимум - естественная цель продажи для пресета свингов',
    },
  }),
  def({
    id: 'sigmaFromMean60d', name: { en: 'Sigma from 60-day mean', ru: 'Отклонение от 60-дневной средней в σ' }, formula: '(last close - 60-day mean close) / 60-day standard deviation of closes', unit: 'ratio', basis: 'price', source: 'planned', direction: 'neutral', appliesTo: BOTH,
    nullWhen: { en: 'fewer than 60 daily closes', ru: 'меньше 60 дневных закрытий' },
    short: { en: 'How stretched the price is versus its 60-day average', ru: 'Насколько цена отклонилась от средней за 60 дней' },
    guide: {
      en: 'The distance of the last close from its 60-day average in standard deviations. Around -2 the price is stretched to the downside, a buy zone for swing trading; around +2 it is stretched up, a zone to take profits. The average lives only inside this metric, there is no separate moving-average column',
      ru: 'Расстояние последнего закрытия от средней за 60 дней в стандартных отклонениях. Около -2 цена растянута вниз, зона покупки для свинга; около +2 - растянута вверх, зона фиксации прибыли. Средняя живёт только внутри этой метрики, отдельной колонки скользящей средней нет',
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
    id: 'sector', name: { en: 'Sector', ru: 'Сектор' }, formula: 'Yahoo assetProfile.sector', unit: 'category', basis: 'meta', source: 'yahoo-summary', direction: 'neutral', appliesTo: BOTH,
    nullWhen: { en: 'Yahoo has no profile (also every ETF for now)', ru: 'у Yahoo нет профиля (пока и у всех ETF)' },
    short: { en: 'Yahoo sector of the company', ru: 'Сектор компании по Yahoo' },
    guide: {
      en: 'The Yahoo sector, such as Technology or Utilities. The sector scope compares a metric with the companies of the same sector as a percentile; a sector with fewer than five companies that have the metric makes such a condition behave as missing',
      ru: 'Сектор по Yahoo, например Technology или Utilities. Scope sector сравнивает метрику с компаниями того же сектора через перцентиль; если в секторе меньше пяти компаний с этой метрикой, условие ведёт себя как пустое',
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

const BASE: MetricDef[] = [...MARKET, ...VALUATION, ...DIVIDENDS, ...BALANCE, ...GROWTH, ...MARGINS, ...PERFORMANCE, ...TOTAL_RETURN, ...META, ...PLANNED, ...FIELDS];

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
