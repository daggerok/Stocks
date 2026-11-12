/// <reference lib="esnext" />
/**
 * XBRL tags behind every field of the SEC layer (screener plan 1.2). Per period the first tag of a list that has a value wins,
 * so an older and a newer tag of one line (SalesRevenueNet, then RevenueFromContractWithCustomer...) join into one series.
 * The `us-gaap` tags come first, then the `ifrs-full` synonyms of the `ifrs` lists (plan 1.3, base: the synonym list of the
 * fundamentals repo): a filer that moved from US GAAP to IFRS (Toyota from FY2021) joins both into one series
 */

/** flow: duration in the reporting currency (income and cash flow statements); instant: balance sheet; perShare: currency/shares; shares: share counts */
export type FieldKind = 'flow' | 'instant' | 'perShare' | 'shares';
export type FieldDef = { kind: FieldKind; tags: string[]; ifrs?: string[]; abs?: boolean };

/** The SEC unit of each kind in the reporting currency: values are stored in that unit with scale 1 (no thousands or millions) */
export function kindUnit(kind: FieldKind, currency = 'USD'): string {
  return kind === 'shares' ? 'shares' : kind === 'perShare' ? `${currency}/shares` : currency;
}

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
  revenue: { kind: 'flow', tags: [...TAGS.revenue, 'RevenuesNetOfInterestExpense'], ifrs: ['Revenue', 'RevenueFromContractsWithCustomers', 'RevenueFromSaleOfGoods'] }, // banks tag quarters with the last one
  costOfRevenue: { kind: 'flow', tags: TAGS.costOfRevenue, ifrs: ['CostOfSales'] },
  grossProfit: { kind: 'flow', tags: TAGS.grossProfit, ifrs: ['GrossProfit'] }, // else revenue - cost of revenue
  operatingExpenses: { kind: 'flow', tags: ['OperatingExpenses'], ifrs: ['OperatingExpenseExcludingCostOfSales'] },
  operatingIncome: { kind: 'flow', tags: TAGS.operatingIncome, ifrs: ['ProfitLossFromOperatingActivities'] },
  da: { kind: 'flow', tags: TAGS.da, ifrs: ['DepreciationAndAmortisationExpense', 'AdjustmentsForDepreciationAndAmortisationExpense'] }, // else Depreciation + AmortizationOfIntangibleAssets
  interestExpense: { kind: 'flow', tags: ['InterestExpense', 'InterestExpenseNonoperating', 'InterestAndDebtExpense', 'InterestExpenseDebt', 'InterestExpenseOperating'], ifrs: ['InterestExpense', 'FinanceCosts'], abs: true },
  otherIncome: { kind: 'flow', tags: ['NonoperatingIncomeExpense', 'OtherNonoperatingIncomeExpense'] },
  pretaxIncome: { kind: 'flow', tags: TAGS.pretax, ifrs: ['ProfitLossBeforeTax'] },
  incomeTax: { kind: 'flow', tags: TAGS.tax, ifrs: ['IncomeTaxExpenseContinuingOperations'] },
  netIncome: { kind: 'flow', tags: TAGS.netIncome, ifrs: ['ProfitLossAttributableToOwnersOfParent', 'ProfitLoss'] },
  epsBasic: { kind: 'perShare', tags: ['EarningsPerShareBasic', 'EarningsPerShareBasicAndDiluted'], ifrs: ['BasicEarningsLossPerShare'] },
  epsDiluted: { kind: 'perShare', tags: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'], ifrs: ['DilutedEarningsLossPerShare'] },
  sharesBasic: { kind: 'shares', tags: ['WeightedAverageNumberOfSharesOutstandingBasic', 'WeightedAverageNumberOfShareOutstandingBasicAndDiluted'], ifrs: ['WeightedAverageShares'] },
  sharesDiluted: { kind: 'shares', tags: ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfShareOutstandingBasicAndDiluted'], ifrs: ['AdjustedWeightedAverageShares'] },
  // cash flow statement (amounts paid are stored as positive numbers)
  cfo: { kind: 'flow', tags: TAGS.ocf, ifrs: ['CashFlowsFromUsedInOperatingActivities'] },
  capex: { kind: 'flow', tags: TAGS.capex, ifrs: ['PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities', 'PurchaseOfPropertyPlantAndEquipment', 'PurchaseOfPropertyPlantAndEquipmentIntangibleAssetsOtherThanGoodwillInvestmentPropertyAndOtherNoncurrentAssets'], abs: true },
  cfi: { kind: 'flow', tags: ['NetCashProvidedByUsedInInvestingActivities', 'NetCashProvidedByUsedInInvestingActivitiesContinuingOperations'], ifrs: ['CashFlowsFromUsedInInvestingActivities'] },
  buybacks: { kind: 'flow', tags: ['PaymentsForRepurchaseOfCommonStock'], ifrs: ['PaymentsToAcquireOrRedeemEntitysShares', 'PurchaseOfTreasuryShares'], abs: true },
  dividendsPaid: { kind: 'flow', tags: TAGS.dividends, ifrs: ['DividendsPaidToEquityHoldersOfParentClassifiedAsFinancingActivities', 'DividendsPaidClassifiedAsFinancingActivities', 'DividendsPaid'], abs: true },
  debtIssued: { kind: 'flow', tags: ['ProceedsFromIssuanceOfLongTermDebt', 'ProceedsFromIssuanceOfDebt', 'ProceedsFromIssuanceOfLongTermDebtAndCapitalSecuritiesNet', 'ProceedsFromIssuanceOfSeniorLongTermDebt', 'ProceedsFromIssuanceOfUnsecuredDebt'], ifrs: ['ProceedsFromBorrowingsClassifiedAsFinancingActivities', 'ProceedsFromNoncurrentBorrowings', 'ProceedsFromIssueOfBondsNotesAndDebentures'], abs: true },
  debtRepaid: { kind: 'flow', tags: ['RepaymentsOfLongTermDebt', 'RepaymentsOfDebt', 'RepaymentsOfLongTermDebtAndCapitalSecurities', 'RepaymentsOfSeniorDebt', 'RepaymentsOfUnsecuredDebt'], ifrs: ['RepaymentsOfBorrowingsClassifiedAsFinancingActivities', 'RepaymentsOfNoncurrentBorrowings', 'RepaymentsOfBondsNotesAndDebentures'], abs: true },
  cff: { kind: 'flow', tags: ['NetCashProvidedByUsedInFinancingActivities', 'NetCashProvidedByUsedInFinancingActivitiesContinuingOperations'], ifrs: ['CashFlowsFromUsedInFinancingActivities'] },
  cashChange: { kind: 'flow', tags: ['CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect', 'CashAndCashEquivalentsPeriodIncreaseDecrease', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseExcludingExchangeRateEffect'], ifrs: ['IncreaseDecreaseInCashAndCashEquivalents', 'IncreaseDecreaseInCashAndCashEquivalentsBeforeEffectOfExchangeRateChanges'] },
  // REIT lines (plan 1.7): Schedule III depreciation is annual only, gains on sale of property
  realEstateDepreciation: { kind: 'flow', tags: ['SECScheduleIIIRealEstateAccumulatedDepreciationDepreciationExpense', 'RealEstateAccumulatedDepreciationDepreciationExpense'], abs: true },
  gainOnSaleOfProperty: { kind: 'flow', tags: ['GainLossOnSaleOfProperties', 'GainsLossesOnSalesOfInvestmentRealEstate', 'GainLossOnSaleOfRealEstateInvestmentProperty', 'GainLossOnDispositionOfAssets', 'GainLossOnSaleOfPropertyPlantEquipment'] },
  // balance sheet
  cash: { kind: 'instant', tags: ['CashAndCashEquivalentsAtCarryingValue', 'Cash', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'], ifrs: ['CashAndCashEquivalents'] }, // cash and equivalents only
  shortTermInvestments: { kind: 'instant', tags: [...TAGS.shortInvestments, 'OtherShortTermInvestments'], ifrs: ['CurrentInvestments'] },
  longTermInvestments: { kind: 'instant', tags: TAGS.longInvestments },
  receivables: { kind: 'instant', tags: TAGS.receivables, ifrs: ['TradeAndOtherCurrentReceivables', 'CurrentTradeReceivables', 'TradeReceivables'] },
  currentAssets: { kind: 'instant', tags: TAGS.currentAssets, ifrs: ['CurrentAssets'] },
  assets: { kind: 'instant', tags: TAGS.assets, ifrs: ['Assets'] },
  currentLiabilities: { kind: 'instant', tags: TAGS.currentLiabilities, ifrs: ['CurrentLiabilities'] },
  liabilities: { kind: 'instant', tags: ['Liabilities'], ifrs: ['Liabilities'] }, // else liabilities and equity - total equity
  longTermDebt: { kind: 'instant', tags: [...TAGS.debtNoncurrent, ...TAGS.debtTotalFallback], ifrs: ['NoncurrentPortionOfNoncurrentBorrowings', 'LongtermBorrowings'] },
  debt: { kind: 'instant', tags: [] }, // short + long-term debt without operating leases, built from the debt tags below
  retainedEarnings: { kind: 'instant', tags: ['RetainedEarningsAccumulatedDeficit'], ifrs: ['RetainedEarnings'] },
  equity: { kind: 'instant', tags: TAGS.equity, ifrs: ['EquityAttributableToOwnersOfParent', 'Equity'] },
  minorityInterest: { kind: 'instant', tags: ['MinorityInterest'], ifrs: ['NoncontrollingInterests'] },
  preferredStock: { kind: 'instant', tags: ['PreferredStockValue', 'PreferredStockValueOutstanding'] },
};

/** Tags read only to build or check a stored field (us-gaap) */
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

/**
 * ifrs-full helpers: the same keys where IFRS has a synonym, plus the IFRS borrowings lines. IFRS debt = Borrowings (total), else
 * non-current borrowings + current borrowings (the combined current line, else the current portion + short-term borrowings) +
 * bonds issued (non-current and current); lease liabilities stay out, like operating leases in US GAAP
 */
export const HELPER_IFRS: Record<string, string[]> = {
  depreciation: ['DepreciationExpense', 'DepreciationPropertyPlantAndEquipmentIncludingRightofuseAssets', 'DepreciationPropertyPlantAndEquipment'],
  amortization: ['AmortisationExpense', 'AmortisationIntangibleAssetsOtherThanGoodwill'],
  liabilitiesAndEquity: ['EquityAndLiabilities'],
  equityTotal: ['Equity'],
  borrowings: ['Borrowings'],
  borrowingsNoncurrent: ['NoncurrentPortionOfNoncurrentBorrowings', 'LongtermBorrowings'],
  borrowingsCurrentCombined: ['CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings'],
  borrowingsCurrentPortion: ['CurrentPortionOfNoncurrentBorrowings', 'CurrentPortionOfLongtermBorrowings'],
  borrowingsShortTerm: ['ShorttermBorrowings'],
  bondsNoncurrent: ['NoncurrentPortionOfNoncurrentBondsIssued'],
  bondsCurrent: ['CurrentBondsIssuedAndCurrentPortionOfNoncurrentBondsIssued'],
};
