/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { SeriesIdentifier, SeriesKey } from '../../../commons/series_id';
import { ScaleType } from '../../../scales/constants';
import { GroupBySpec, BinAgg, Direction, XScaleType, DEFAULT_SINGLE_PANEL_SM_VALUE } from '../../../specs';
import { OrderBy } from '../../../specs/settings';
import { ColorOverrides } from '../../../state/chart_state';
import { Accessor, AccessorFn, getAccessorValue } from '../../../utils/accessor';
import { Datum, Color, isNil } from '../../../utils/commons';
import { GroupId } from '../../../utils/ids';
import { Logger } from '../../../utils/logger';
import { ColorConfig } from '../../../utils/themes/theme';
import { groupSeriesByYGroup, isHistogramEnabled, isStackedSpec } from '../domains/y_domain';
import { LastValues } from '../state/utils/types';
import { applyFitFunctionToDataSeries } from './fit_function_utils';
import { groupBy } from './group_data_series';
import { BasicSeriesSpec, SeriesTypes, SeriesSpecs, SeriesNameConfigOptions, StackMode } from './specs';
import { formatStackedDataSeriesValues, datumXSortPredicate } from './stacked_series_utils';

/** @internal */
export const SERIES_DELIMITER = ' - ';

/** @public */
export interface FilledValues {
  /** the x value */
  x?: number | string;
  /** the max y value */
  y1?: number;
  /** the minimum y value */
  y0?: number;
}

/** @public */
export interface DataSeriesDatum<T = any> {
  /** the x value */
  x: number | string;
  /** the max y value */
  y1: number | null;
  /** the minimum y value */
  y0: number | null;
  /** initial y1 value, non stacked */
  initialY1: number | null;
  /** initial y0 value, non stacked */
  initialY0: number | null;
  /** the optional mark metric, used for lines and area series */
  mark: number | null;
  /** initial datum */
  datum: T;
  /** the list of filled values because missing or nulls */
  filled?: FilledValues;
}

export interface XYChartSeriesIdentifier extends SeriesIdentifier {
  yAccessor: string | number;
  splitAccessors: Map<string | number, string | number>; // does the map have a size vs making it optional
  smVerticalAccessorValue?: string | number;
  smHorizontalAccessorValue?: string | number;
  seriesKeys: (string | number)[];
}

/** @internal */
export type DataSeries = XYChartSeriesIdentifier & {
  groupId: GroupId;
  seriesType: SeriesTypes;
  data: DataSeriesDatum[];
  isStacked: boolean;
  stackMode: StackMode | undefined;
  spec: Exclude<BasicSeriesSpec, 'data'>;
};

/** @internal */
export interface FormattedDataSeries {
  groupId: GroupId;
  dataSeries: DataSeries[];
  counts: DataSeriesCounts;
  stackMode?: StackMode;
}

/** @internal */
export type DataSeriesCounts = { [key in SeriesTypes]: number };

/** @internal */
export type SeriesCollectionValue = {
  banded?: boolean;
  lastValue?: LastValues;
  specSortIndex?: number;
  seriesIdentifier: XYChartSeriesIdentifier;
};

/** @internal */
export function getSeriesIndex(series: SeriesIdentifier[], target: SeriesIdentifier): number {
  if (!series) {
    return -1;
  }

  return series.findIndex(({ key }) => target.key === key);
}

/**
 * Split a dataset into multiple series depending on the accessors.
 * Each series is then associated with a key thats belong to its configuration.
 * This method removes every data with an invalid x: a string or number value is required
 * `y` values and `mark` values are casted to number or null.
 * @internal
 */
export function splitSeriesDataByAccessors(
  spec: BasicSeriesSpec,
  xValueSums: Map<string | number, number>,
  isStacked = false,
  enableVislibSeriesSort = false,
  stackMode?: StackMode,
  smallMultiples?: { vertical?: GroupBySpec; horizontal?: GroupBySpec },
): {
  dataSeries: Map<SeriesKey, DataSeries>;
  xValues: Array<string | number>;
  smVValues: Set<string | number>;
  smHValues: Set<string | number>;
} {
  const {
    seriesType,
    id: specId,
    groupId,
    data,
    xAccessor,
    yAccessors,
    y0Accessors,
    markSizeAccessor,
    splitSeriesAccessors = [],
  } = spec;
  const dataSeries = new Map<SeriesKey, DataSeries>();
  const xValues: Array<string | number> = [];
  const smVValues: Set<string | number> = new Set();
  const smHValues: Set<string | number> = new Set();
  const nonNumericValues: any[] = [];

  if (enableVislibSeriesSort) {
    /*
     * This logic is mostly duplicated from below but is a temporary fix before
     * https://github.com/elastic/elastic-charts/issues/795 is completed to allow sorting
     * The difference from below is that it loops through all the yAsccessors before the data.
     */
    yAccessors.forEach((accessor, index) => {
      for (let i = 0; i < data.length; i++) {
        const datum = data[i];
        const splitAccessors = getSplitAccessors(datum, splitSeriesAccessors);
        // if splitSeriesAccessors are defined we should have at least one split value to include datum
        if (splitSeriesAccessors.length > 0 && splitAccessors.size < 1) {
          continue;
        }

        // skip if the datum is not an object or null
        if (typeof datum !== 'object' || datum === null) {
          continue;
        }
        const x = getAccessorValue(datum, xAccessor);

        // skip if the x value is not a string or a number
        if (typeof x !== 'string' && typeof x !== 'number') {
          continue;
        }

        xValues.push(x);
        let sum = xValueSums.get(x) ?? 0;

        // extract small multiples aggregation values
        const smH = smallMultiples?.horizontal?.by
          ? smallMultiples.horizontal?.by(spec, datum)
          : DEFAULT_SINGLE_PANEL_SM_VALUE;
        if (!isNil(smH)) {
          smHValues.add(smH);
        }

        const smV = smallMultiples?.vertical?.by
          ? smallMultiples.vertical.by(spec, datum)
          : DEFAULT_SINGLE_PANEL_SM_VALUE;
        if (!isNil(smV)) {
          smVValues.add(smV);
        }

        const cleanedDatum = extractYAndMarkFromDatum(
          datum,
          accessor,
          nonNumericValues,
          y0Accessors && y0Accessors[index],
          markSizeAccessor,
        );
        const seriesKeys = [...splitAccessors.values(), accessor];
        const seriesIdentifier = {
          specId,
          groupId,
          seriesType,
          yAccessor: accessor,
          splitAccessors,
          smVerticalAccessorValue: smV,
          smHorizontalAccessorValue: smH,
          stackMode,
        };
        const seriesKey = getSeriesKey(seriesIdentifier, groupId);
        sum += cleanedDatum.y1 ?? 0;
        const newDatum = { x, ...cleanedDatum, smH, smV };
        const series = dataSeries.get(seriesKey);
        if (series) {
          series.data.push(newDatum);
        } else {
          dataSeries.set(seriesKey, {
            ...seriesIdentifier,
            isStacked,
            seriesKeys,
            key: seriesKey,
            data: [newDatum],
            spec,
          });
        }
        xValueSums.set(x, sum);
      }
    });
  } else {
    for (let i = 0; i < data.length; i++) {
      const datum = data[i];
      const splitAccessors = getSplitAccessors(datum, splitSeriesAccessors);
      // if splitSeriesAccessors are defined we should have at least one split value to include datum
      if (splitSeriesAccessors.length > 0 && splitAccessors.size < 1) {
        continue;
      }

      // skip if the datum is not an object or null
      if (typeof datum !== 'object' || datum === null) {
        continue;
      }
      const x = getAccessorValue(datum, xAccessor);
      // skip if the x value is not a string or a number
      if (typeof x !== 'string' && typeof x !== 'number') {
        continue;
      }

      xValues.push(x);
      let sum = xValueSums.get(x) ?? 0;

      // extract small multiples aggregation values
      const smH = smallMultiples?.horizontal?.by
        ? smallMultiples.horizontal?.by(spec, datum)
        : DEFAULT_SINGLE_PANEL_SM_VALUE;
      if (!isNil(smH)) {
        smHValues.add(smH);
      }

      const smV = smallMultiples?.vertical?.by
        ? smallMultiples.vertical.by(spec, datum)
        : DEFAULT_SINGLE_PANEL_SM_VALUE;
      if (!isNil(smV)) {
        smVValues.add(smV);
      }

      yAccessors.forEach((accessor, index) => {
        const cleanedDatum = extractYAndMarkFromDatum(
          datum,
          accessor,
          nonNumericValues,
          y0Accessors && y0Accessors[index],
          markSizeAccessor,
        );
        const seriesKeys = [...splitAccessors.values(), accessor];
        const seriesIdentifier = {
          specId,
          groupId,
          seriesType,
          yAccessor: accessor,
          splitAccessors,
          smVerticalAccessorValue: smV,
          smHorizontalAccessorValue: smH,
          stackMode,
        };
        const seriesKey = getSeriesKey(seriesIdentifier, groupId);
        sum += cleanedDatum.y1 ?? 0;
        const newDatum = { x, ...cleanedDatum, smH, smV };
        const series = dataSeries.get(seriesKey);
        if (series) {
          series.data.push(newDatum);
        } else {
          dataSeries.set(seriesKey, {
            ...seriesIdentifier,
            isStacked,
            seriesKeys,
            key: seriesKey,
            data: [newDatum],
            spec,
          });
        }

        xValueSums.set(x, sum);
      });
    }
  }

  if (nonNumericValues.length > 0) {
    Logger.warn(
      `Found non-numeric y value${nonNumericValues.length > 1 ? 's' : ''} in dataset for spec "${specId}"`,
      `(${nonNumericValues.map((v) => JSON.stringify(v)).join(', ')})`,
    );
  }
  return {
    dataSeries,
    xValues,
    smVValues,
    smHValues,
  };
}

/**
 * Gets global series key to id any series as a string
 * @internal
 */
export function getSeriesKey(
  {
    specId,
    yAccessor,
    splitAccessors,
    smVerticalAccessorValue,
    smHorizontalAccessorValue,
  }: Pick<
    XYChartSeriesIdentifier,
    'specId' | 'yAccessor' | 'splitAccessors' | 'smVerticalAccessorValue' | 'smHorizontalAccessorValue'
  >,
  groupId: GroupId,
): string {
  const joinedAccessors = [...splitAccessors.entries()]
    .sort(([a], [b]) => (a > b ? 1 : -1))
    .map(([key, value]) => `${key}-${value}`)
    .join('|');
  const smV = smVerticalAccessorValue ? `smV{${smVerticalAccessorValue}}` : '';
  const smH = smHorizontalAccessorValue ? `smH{${smHorizontalAccessorValue}}` : '';
  return `groupId{${groupId}}spec{${specId}}yAccessor{${yAccessor}}splitAccessors{${joinedAccessors}}${smV}${smH}`;
}

/**
 * Get the array of values that forms a series key
 * @internal
 */
function getSplitAccessors(datum: Datum, accessors: Accessor[] = []): Map<string | number, string | number> {
  const splitAccessors = new Map<string | number, string | number>();
  if (typeof datum === 'object' && datum !== null) {
    accessors.forEach((accessor: Accessor) => {
      const value = datum[accessor as keyof typeof datum];
      if (typeof value === 'string' || typeof value === 'number') {
        splitAccessors.set(accessor, value);
      }
    });
  }
  return splitAccessors;
}

/**
 * Extract y1 and y0 and mark properties from Datum. Casting them to numbers or null
 * @internal
 */
export function extractYAndMarkFromDatum(
  datum: Datum,
  yAccessor: Accessor,
  nonNumericValues: any[],
  y0Accessor?: Accessor,
  markSizeAccessor?: Accessor | AccessorFn,
): Pick<DataSeriesDatum, 'y0' | 'y1' | 'mark' | 'datum' | 'initialY0' | 'initialY1'> {
  const mark =
    markSizeAccessor === undefined ? null : castToNumber(getAccessorValue(datum, markSizeAccessor), nonNumericValues);
  const y1 = castToNumber(datum[yAccessor], nonNumericValues);
  const y0 = y0Accessor ? castToNumber(datum[y0Accessor as keyof typeof datum], nonNumericValues) : null;
  return { y1, datum, y0, mark, initialY0: y0, initialY1: y1 };
}

function castToNumber(value: any, nonNumericValues: any[]): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const num = Number(value);

  if (isNaN(num)) {
    nonNumericValues.push(value);
    return null;
  }
  return num;
}

/**
 * Sorts data based on order of xValues
 * @param dataSeries
 * @param xValues
 * @param xScaleType
 */
const getSortedDataSeries = (
  dataSeries: DataSeries[],
  xValues: Set<string | number>,
  xScaleType: ScaleType,
): DataSeries[] =>
  dataSeries.map(({ data, ...rest }) => ({
    ...rest,
    data: data.sort(datumXSortPredicate(xScaleType, [...xValues.values()])),
  }));

/** @internal */
export function getFormattedDataSeries(
  seriesSpecs: SeriesSpecs,
  availableDataSeries: DataSeries[],
  xValues: Set<string | number>,
  xScaleType: ScaleType,
): DataSeries[] {
  const histogramEnabled = isHistogramEnabled(seriesSpecs);

  // apply fit function to every data series
  const fittedDataSeries = applyFitFunctionToDataSeries(
    getSortedDataSeries(availableDataSeries, xValues, xScaleType),
    seriesSpecs,
    xScaleType,
  );

  // apply fitting for stacked DataSeries by YGroup, Panel
  const stackedDataSeries = fittedDataSeries.filter(({ spec }) => isStackedSpec(spec, histogramEnabled));
  const stackedGroups = groupBy<DataSeries>(
    stackedDataSeries,
    ['smHorizontalAccessorValue', 'smVerticalAccessorValue', 'groupId'],
    true,
  );

  const fittedAndStackedDataSeries = stackedGroups.reduce<DataSeries[]>((acc, dataSeries) => {
    const [{ stackMode }] = dataSeries;
    const formatted = formatStackedDataSeriesValues(dataSeries, xValues, stackMode);
    return [...acc, ...formatted];
  }, []);
  // get already fitted non stacked dataSeries
  const nonStackedDataSeries = fittedDataSeries.filter(({ spec }) => !isStackedSpec(spec, histogramEnabled));

  return [...fittedAndStackedDataSeries, ...nonStackedDataSeries];
}

/**
 *
 * @param seriesSpecs the map for all the series spec
 * @param deselectedDataSeries the array of deselected/hidden data series
 * @param enableVislibSeriesSort is optional; if not specified in <Settings />,
 * @param smallMultiples
 * @internal
 */
export function getDataSeriesFromSpecs(
  seriesSpecs: BasicSeriesSpec[],
  deselectedDataSeries: SeriesIdentifier[] = [],
  orderOrdinalBinsBy?: OrderBy,
  enableVislibSeriesSort?: boolean,
  smallMultiples?: { vertical?: GroupBySpec; horizontal?: GroupBySpec },
): {
  dataSeries: DataSeries[];
  seriesCollection: Map<SeriesKey, SeriesCollectionValue>;
  xValues: Set<string | number>;
  smVValues: Set<string | number>;
  smHValues: Set<string | number>;
  fallbackScale?: XScaleType;
} {
  let globalDataSeries: DataSeries[] = [];
  const seriesCollection = new Map<SeriesKey, SeriesCollectionValue>();
  const mutatedXValueSums = new Map<string | number, number>();

  // the unique set of values along the x axis
  const globalXValues: Set<string | number> = new Set();

  // the unique set of values along for the vertical small multiple grid
  let globalSMVValues: Set<string | number> = new Set();
  // the unique set of values along for the horizontal small multiple grid
  let globalSMHValues: Set<string | number> = new Set();

  let isNumberArray = true;
  let isOrdinalScale = false;

  const specsByYGroup = groupSeriesByYGroup(seriesSpecs);
  // eslint-disable-next-line no-restricted-syntax
  for (const spec of seriesSpecs) {
    // check scale type and cast to Ordinal if we found at least one series
    // with Ordinal Scale
    if (spec.xScaleType === ScaleType.Ordinal) {
      isOrdinalScale = true;
    }

    const specGroup = specsByYGroup.get(spec.groupId);
    const isStacked = Boolean(specGroup?.stacked.find(({ id }) => id === spec.id));
    const { dataSeries, xValues, smVValues, smHValues } = splitSeriesDataByAccessors(
      spec,
      mutatedXValueSums,
      isStacked,
      enableVislibSeriesSort,
      specGroup?.stackMode,
      smallMultiples,
    );

    // filter deselected DataSeries
    let filteredDataSeries: DataSeries[] = [...dataSeries.values()];
    if (deselectedDataSeries.length > 0) {
      filteredDataSeries = filteredDataSeries.filter(
        ({ key }) => !deselectedDataSeries.some(({ key: deselectedKey }) => key === deselectedKey),
      );
    }

    globalDataSeries = [...globalDataSeries, ...filteredDataSeries];

    const banded = spec.y0Accessors && spec.y0Accessors.length > 0;

    dataSeries.forEach((series, key) => {
      const { data, ...seriesIdentifier } = series;
      seriesCollection.set(key, {
        banded,
        specSortIndex: spec.sortIndex,
        seriesIdentifier,
      });
    });

    // check the nature of the x values. If all of them are numbers
    // we can use a continuous scale, if not we should use an ordinal scale.
    // The xValue is already casted to be a valid number or a string
    // eslint-disable-next-line no-restricted-syntax
    for (const xValue of xValues) {
      if (isNumberArray && typeof xValue !== 'number') {
        isNumberArray = false;
      }
      globalXValues.add(xValue);
    }
    globalSMVValues = new Set([...globalSMVValues, ...smVValues]);
    globalSMHValues = new Set([...globalSMHValues, ...smHValues]);
  }

  const xValues =
    isOrdinalScale || !isNumberArray
      ? getSortedOrdinalXValues(globalXValues, mutatedXValueSums, orderOrdinalBinsBy)
      : new Set(
          [...globalXValues].sort((a, b) => {
            if (typeof a === 'string' || typeof b === 'string') {
              return 0;
            }
            return a - b;
          }),
        );

  return {
    dataSeries: globalDataSeries,
    seriesCollection,
    // keep the user order for ordinal scales
    xValues,
    smVValues: globalSMVValues,
    smHValues: globalSMHValues,
    fallbackScale: !isOrdinalScale && !isNumberArray ? ScaleType.Ordinal : undefined,
  };
}

function getSortedOrdinalXValues(
  xValues: Set<string | number>,
  xValueSums: Map<string | number, number>,
  orderOrdinalBinsBy?: OrderBy,
) {
  if (!orderOrdinalBinsBy) {
    return xValues; // keep the user order for ordinal scales
  }

  switch (orderOrdinalBinsBy?.binAgg) {
    case BinAgg.None:
      return xValues; // keep the user order for ordinal scales
    case BinAgg.Sum:
    default:
      return new Set(
        [...xValues].sort((v1, v2) => {
          return (
            (orderOrdinalBinsBy.direction === Direction.Ascending ? 1 : -1) *
            ((xValueSums.get(v1) ?? 0) - (xValueSums.get(v2) ?? 0))
          );
        }),
      );
  }
}

function getSeriesNameFromOptions(
  options: SeriesNameConfigOptions,
  { yAccessor, splitAccessors }: XYChartSeriesIdentifier,
  delimiter: string,
): string | null {
  if (!options.names) {
    return null;
  }

  return (
    options.names
      .slice()
      .sort(({ sortIndex: a = Infinity }, { sortIndex: b = Infinity }) => a - b)
      .map(({ accessor, value, name }) => {
        const accessorValue = splitAccessors.get(accessor) ?? null;
        if (accessorValue === value) {
          return name ?? value;
        }

        if (yAccessor === accessor) {
          return name ?? accessor;
        }
        return null;
      })
      .filter((d) => Boolean(d) || d === 0)
      .join(delimiter) || null
  );
}

/**
 * Get series name based on `SeriesIdentifier`
 * @internal
 */
export function getSeriesName(
  seriesIdentifier: XYChartSeriesIdentifier,
  hasSingleSeries: boolean,
  isTooltip: boolean,
  spec?: BasicSeriesSpec,
): string {
  let delimiter = SERIES_DELIMITER;
  if (spec && spec.name && typeof spec.name !== 'string') {
    let customLabel: string | number | null = null;
    if (typeof spec.name === 'function') {
      customLabel = spec.name(seriesIdentifier, isTooltip);
    } else {
      delimiter = spec.name.delimiter ?? delimiter;
      customLabel = getSeriesNameFromOptions(spec.name, seriesIdentifier, delimiter);
    }

    if (customLabel !== null) {
      return customLabel.toString();
    }
  }

  let name = '';
  const nameKeys =
    spec && spec.yAccessors.length > 1 ? seriesIdentifier.seriesKeys : seriesIdentifier.seriesKeys.slice(0, -1);

  // there is one series, the is only one yAccessor, the first part is not null
  if (hasSingleSeries || nameKeys.length === 0 || nameKeys[0] == null) {
    if (!spec) {
      return '';
    }

    if (spec.splitSeriesAccessors && nameKeys.length > 0 && nameKeys[0] != null) {
      name = nameKeys.join(delimiter);
    } else {
      name = typeof spec.name === 'string' ? spec.name : `${spec.id}`;
    }
  } else {
    name = nameKeys.join(delimiter);
  }

  return name;
}

function getSortIndex({ specSortIndex }: SeriesCollectionValue, total: number): number {
  return specSortIndex != null ? specSortIndex : total;
}

/** @internal */
export function getSortedDataSeriesColorsValuesMap(
  seriesCollection: Map<SeriesKey, SeriesCollectionValue>,
): Map<SeriesKey, SeriesCollectionValue> {
  const seriesColorsArray = [...seriesCollection];
  seriesColorsArray.sort(
    ([, specA], [, specB]) => getSortIndex(specA, seriesCollection.size) - getSortIndex(specB, seriesCollection.size),
  );

  return new Map([...seriesColorsArray]);
}

/**
 * Helper function to get highest override color.
 *
 * from highest to lowest: `temporary`, `seriesSpec.color` then `persisted`
 *
 * @param key
 * @param customColors
 * @param overrides
 */
function getHighestOverride(
  key: string,
  customColors: Map<SeriesKey, Color>,
  overrides: ColorOverrides,
): Color | undefined {
  let color: Color | undefined = overrides.temporary[key];

  if (color) {
    return color;
  }

  color = customColors.get(key);

  if (color) {
    return color;
  }

  return overrides.persisted[key];
}

/**
 * Returns color for a series given all color hierarchies
 *
 * @param seriesCollection
 * @param chartColors
 * @param customColors
 * @param overrides
 * @internal
 */
export function getSeriesColors(
  seriesCollection: Map<SeriesKey, SeriesCollectionValue>,
  chartColors: ColorConfig,
  customColors: Map<SeriesKey, Color>,
  overrides: ColorOverrides,
): Map<SeriesKey, Color> {
  const seriesColorMap = new Map<SeriesKey, Color>();
  let counter = 0;

  seriesCollection.forEach((_, seriesKey) => {
    const colorOverride = getHighestOverride(seriesKey, customColors, overrides);
    const color = colorOverride || chartColors.vizColors[counter % chartColors.vizColors.length];

    seriesColorMap.set(seriesKey, color);
    counter++;
  });
  return seriesColorMap;
}
