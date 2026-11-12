/// <reference lib="esnext" />
/**
 * XBRL tags behind every field of the SEC layer (screener plan 1.2). Per period the first tag of a list that has a value wins,
 * so an older and a newer tag of one line (SalesRevenueNet, then RevenueFromContractWithCustomer...) join into one series.
 * Only `us-gaap` is read today; `ifrs-full` synonyms (plan 1.3) go into the `ifrs` lists of the same table later
 */

/** flow: duration in USD (income and cash flow statements); instant: balance sheet USD; perShare: USD/shares; shares: share counts */
export type FieldKind = 'flow' | 'instant' | 'perShare' | 'shares';
export type FieldDef = { kind: FieldKind; tags: string[]; abs?: boolean };

/** The SEC unit of each kind: values are stored in that unit with scale 1 (no thousands or millions) */
export const KIND_UNITS: Record<FieldKind, string> = { flow: 'USD', instant: 'USD', perShare: 'USD/shares', shares: 'shares' };

// lists shared with the annual rows of update-data.ts (buildAnnualRows): same tags, same order
export const TAGS = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueGoodsNet', 'SalesRevenueServicesNet'],
  costOfRevenue: ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold'],
  grossProfit: ['GrossProfit'],
  operatingIncome: ['OperatingIncomeLoss'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss'],
  da: ['DepreciationDepletionAndAmortization', 'DepreciationAndAmortization', 'DepreciationAmortizationAndAccretionNet', 'DepreciationAmortizationAndOther'],
  ocf: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets', 'PaymentsForCapitalImprovements'],
  dividends: ['PaymentsOfDividends', 'PaymentsOfDividendsCommonStock'],
  pretax: ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments'],
  tax: ['IncomeTaxExpenseBenefit'],
  assets: ['Assets'],
  currentAssets: ['AssetsCurrent'],
  currentLiabilities: ['LiabilitiesCurrent'],
  cash: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsAndShortTermInvestments', 'CashAndCashEquivalentsAtCarryingValueIncludingRestrictedCash'],
  shortInvestments: ['MarketableSecuritiesCurrent', 'ShortTermInvestments', 'AvailableForSaleSecuritiesDebtSecuritiesCurrent'],
  longInvestments: ['MarketableSecuritiesNoncurrent', 'AvailableForSaleSecuritiesDebtSecuritiesNoncurrent', 'LongTermInvestments'],
  receivables: ['AccountsReceivableNetCurrent', 'ReceivablesNetCurrent'],
  debtCombined: ['DebtLongtermAndShorttermCombinedAmount'],
  debtNoncurrent: ['LongTermDebtNoncurrent', 'LongTermDebtAndCapitalLeaseObligations'],
  debtCurrent: ['LongTermDebtCurrent', 'DebtCurrent', 'LongTermDebtAndCapitalLeaseObligationsCurrent'],
  debtTotalFallback: ['LongTermDebt'],
  commercialPaper: ['CommercialPaper', 'ShortTermBorrowings'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
};

/** Fields stored per period in meta.json `fundamentals.sec` (the order of this table is the order of the stored keys) */
export const SEC_FIELDS: Record<string, FieldDef> = {
  // income statement
  revenue: { kind: 'flow', tags: [...TAGS.revenue, 'RevenuesNetOfInterestExpense'] }, // banks tag quarters with the last one
  costOfRevenue: { kind: 'flow', tags: TAGS.costOfRevenue },
  grossProfit: { kind: 'flow', tags: TAGS.grossProfit }, // else revenue - cost of revenue
  operatingExpenses: { kind: 'flow', tags: ['OperatingExpenses'] },
  operatingIncome: { kind: 'flow', tags: TAGS.operatingIncome },
  da: { kind: 'flow', tags: TAGS.da }, // else Depreciation + AmortizationOfIntangibleAssets
  interestExpense: { kind: 'flow', tags: ['InterestExpense', 'InterestExpenseNonoperating', 'InterestAndDebtExpense', 'InterestExpenseDebt', 'InterestExpenseOperating'], abs: true },
  otherIncome: { kind: 'flow', tags: ['NonoperatingIncomeExpense', 'OtherNonoperatingIncomeExpense'] },
  pretaxIncome: { kind: 'flow', tags: TAGS.pretax },
  incomeTax: { kind: 'flow', tags: TAGS.tax },
  netIncome: { kind: 'flow', tags: TAGS.netIncome },
  epsBasic: { kind: 'perShare', tags: ['EarningsPerShareBasic', 'EarningsPerShareBasicAndDiluted'] },
  epsDiluted: { kind: 'perShare', tags: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'] },
  sharesBasic: { kind: 'shares', tags: ['WeightedAverageNumberOfSharesOutstandingBasic', 'WeightedAverageNumberOfShareOutstandingBasicAndDiluted'] },
  sharesDiluted: { kind: 'shares', tags: ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfShareOutstandingBasicAndDiluted'] },
  // cash flow statement (amounts paid are stored as positive numbers)
  cfo: { kind: 'flow', tags: TAGS.ocf },
  capex: { kind: 'flow', tags: TAGS.capex, abs: true },
  cfi: { kind: 'flow', tags: ['NetCashProvidedByUsedInInvestingActivities', 'NetCashProvidedByUsedInInvestingActivitiesContinuingOperations'] },
  buybacks: { kind: 'flow', tags: ['PaymentsForRepurchaseOfCommonStock'], abs: true },
  dividendsPaid: { kind: 'flow', tags: TAGS.dividends, abs: true },
  debtIssued: { kind: 'flow', tags: ['ProceedsFromIssuanceOfLongTermDebt', 'ProceedsFromIssuanceOfDebt', 'ProceedsFromIssuanceOfLongTermDebtAndCapitalSecuritiesNet', 'ProceedsFromIssuanceOfSeniorLongTermDebt', 'ProceedsFromIssuanceOfUnsecuredDebt'], abs: true },
  debtRepaid: { kind: 'flow', tags: ['RepaymentsOfLongTermDebt', 'RepaymentsOfDebt', 'RepaymentsOfLongTermDebtAndCapitalSecurities', 'RepaymentsOfSeniorDebt', 'RepaymentsOfUnsecuredDebt'], abs: true },
  cff: { kind: 'flow', tags: ['NetCashProvidedByUsedInFinancingActivities', 'NetCashProvidedByUsedInFinancingActivitiesContinuingOperations'] },
  cashChange: { kind: 'flow', tags: ['CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect', 'CashAndCashEquivalentsPeriodIncreaseDecrease', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseExcludingExchangeRateEffect'] },
  // REIT lines (plan 1.7): Schedule III depreciation is annual only, gains on sale of property
  realEstateDepreciation: { kind: 'flow', tags: ['SECScheduleIIIRealEstateAccumulatedDepreciationDepreciationExpense', 'RealEstateAccumulatedDepreciationDepreciationExpense'], abs: true },
  gainOnSaleOfProperty: { kind: 'flow', tags: ['GainLossOnSaleOfProperties', 'GainsLossesOnSalesOfInvestmentRealEstate', 'GainLossOnSaleOfRealEstateInvestmentProperty', 'GainLossOnDispositionOfAssets', 'GainLossOnSaleOfPropertyPlantEquipment'] },
  // balance sheet
  cash: { kind: 'instant', tags: ['CashAndCashEquivalentsAtCarryingValue', 'Cash', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'] }, // cash and equivalents only
  shortTermInvestments: { kind: 'instant', tags: [...TAGS.shortInvestments, 'OtherShortTermInvestments'] },
  longTermInvestments: { kind: 'instant', tags: TAGS.longInvestments },
  receivables: { kind: 'instant', tags: TAGS.receivables },
  currentAssets: { kind: 'instant', tags: TAGS.currentAssets },
  assets: { kind: 'instant', tags: TAGS.assets },
  currentLiabilities: { kind: 'instant', tags: TAGS.currentLiabilities },
  liabilities: { kind: 'instant', tags: ['Liabilities'] }, // else liabilities and equity - total equity
  longTermDebt: { kind: 'instant', tags: [...TAGS.debtNoncurrent, ...TAGS.debtTotalFallback] },
  debt: { kind: 'instant', tags: [] }, // short + long-term debt without operating leases, built from the debt tags below
  retainedEarnings: { kind: 'instant', tags: ['RetainedEarningsAccumulatedDeficit'] },
  equity: { kind: 'instant', tags: TAGS.equity },
  minorityInterest: { kind: 'instant', tags: ['MinorityInterest'] },
  preferredStock: { kind: 'instant', tags: ['PreferredStockValue', 'PreferredStockValueOutstanding'] },
};

/** Tags read only to build or check a stored field */
export const HELPER_TAGS = {
  depreciation: ['Depreciation'],
  amortization: ['AmortizationOfIntangibleAssets'],
  cashAndShortTerm: ['CashCashEquivalentsAndShortTermInvestments'],
  liabilitiesAndEquity: ['LiabilitiesAndStockholdersEquity'],
  equityTotal: ['StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  debtCombined: TAGS.debtCombined,
  debtNoncurrent: TAGS.debtNoncurrent,
  debtCurrent: TAGS.debtCurrent,
  debtTotalFallback: TAGS.debtTotalFallback,
  commercialPaper: TAGS.commercialPaper,
  // only for a period without any of the debt tags above (REITs such as O report notes and mortgages): their sum is the debt
  notesPayable: ['NotesPayable', 'SeniorNotes', 'UnsecuredDebt'],
  securedDebt: ['SecuredDebt'],
  lineOfCredit: ['LineOfCredit'],
};
