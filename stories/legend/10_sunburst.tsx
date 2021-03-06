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

import { boolean, number } from '@storybook/addon-knobs';
import React from 'react';

import { Chart, Datum, Partition, PartitionLayout, Settings } from '../../src';
import { config } from '../../src/chart_types/partition_chart/layout/config/config';
import { ShapeTreeNode } from '../../src/chart_types/partition_chart/layout/types/viewmodel_types';
import { mocks } from '../../src/mocks/hierarchical';
import { STORYBOOK_LIGHT_THEME } from '../shared';
import {
  categoricalFillColor,
  colorBrewerCategoricalStark9,
  countryLookup,
  productLookup,
  regionLookup,
} from '../utils/utils';

export const Example = () => {
  const flatLegend = boolean('flatLegend', true);
  const legendMaxDepth = number('legendMaxDepth', 2, {
    min: 0,
    max: 3,
    step: 1,
  });

  return (
    <Chart className="story-chart">
      <Settings showLegend flatLegend={flatLegend} legendMaxDepth={legendMaxDepth} theme={STORYBOOK_LIGHT_THEME} />
      <Partition
        id="spec_1"
        data={mocks.miniSunburst}
        valueAccessor={(d: Datum) => d.exportVal as number}
        valueFormatter={(d: number) => `$${config.fillLabel.valueFormatter(Math.round(d / 1000000000))}\u00A0Bn`}
        layers={[
          {
            groupByRollup: (d: Datum) => d.sitc1,
            nodeLabel: (d: any) => productLookup[d].name,
            shape: {
              fillColor: (d: ShapeTreeNode) => categoricalFillColor(colorBrewerCategoricalStark9, 0.7)(d.sortIndex),
            },
          },
          {
            groupByRollup: (d: Datum) => countryLookup[d.dest].continentCountry.slice(0, 2),
            nodeLabel: (d: any) => regionLookup[d].regionName,
            shape: {
              fillColor: (d: ShapeTreeNode) =>
                categoricalFillColor(colorBrewerCategoricalStark9, 0.5)(d.parent.sortIndex),
            },
          },
          {
            groupByRollup: (d: Datum) => d.dest,
            nodeLabel: (d: any) => countryLookup[d].name,
            shape: {
              fillColor: (d: ShapeTreeNode) =>
                categoricalFillColor(colorBrewerCategoricalStark9, 0.3)(d.parent.parent.sortIndex),
            },
          },
        ]}
        config={{
          partitionLayout: PartitionLayout.sunburst,
          linkLabel: {
            maxCount: 0,
            fontSize: 14,
          },
          fontFamily: 'Arial',
          fillLabel: {
            valueFormatter: (d: number) => `$${config.fillLabel.valueFormatter(Math.round(d / 1000000000))}\u00A0Bn`,
            fontStyle: 'italic',
            textInvertible: true,
            fontWeight: 900,
            valueFont: {
              fontFamily: 'Menlo',
              fontStyle: 'normal',
              fontWeight: 100,
            },
          },
          margin: { top: 0, bottom: 0, left: 0, right: 0 },
          minFontSize: 1,
          idealFontSizeJump: 1.1,
          outerSizeRatio: 1,
          emptySizeRatio: 0,
          circlePadding: 4,
          backgroundColor: 'rgba(229,229,229,1)',
        }}
      />
    </Chart>
  );
};

Example.story = {
  parameters: {
    info: {
      text: `To flatten a hierarchical legend (like the rendered in a pie chart or a treemap when using a multi-layer configuration) you can
add the \`flatLegend\` prop into the \`<Settings />\` component.

To limit displayed hierarchy to a specific depth, you can use the \`legendMaxDepth\` prop. The first layer will have a depth of \`1\`.`,
    },
  },
};
