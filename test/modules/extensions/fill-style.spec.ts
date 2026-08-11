// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {WebMercatorViewport} from '@deck.gl/core';
import {FillStyleExtension} from '@deck.gl/extensions';
import {PolygonLayer} from '@deck.gl/layers';
import {getLayerUniforms, testLayer, device} from '@deck.gl/test-utils/vitest';

import * as FIXTURES from 'deck.gl-test/data';
const webglTest = device.type === 'webgl' ? test : test.skip;

const FILL_PATTERN_ATLAS = new Uint8Array(4);
const FILL_PATTERN_MAPPING = {
  pattern: {x: 0, y: 0, width: 1, height: 1}
};

// Kept independent of the implementation's constant on purpose.
const FILL_UV_SCALE = 512 / 40000000;
const modFloor = (x: number, y: number) => x - y * Math.floor(x / y);

webglTest('FillStyleExtension#PolygonLayer', () => {
  const testCases = [
    {
      props: {
        id: 'fill-style-extension-test',
        data: FIXTURES.polygons,
        getPolygon: d => d,

        fillPatternAtlas: FILL_PATTERN_ATLAS,
        fillPatternMapping: FILL_PATTERN_MAPPING,
        getFillPattern: f => 'pattern',
        getFillPatternOffset: [0.5, 0.5],
        getFillPatternScale: 2,

        extensions: [new FillStyleExtension({pattern: true})]
      },
      onAfterUpdate: ({layer, subLayers}) => {
        expect(layer.state.emptyTexture, 'should not be enabled in composite layer').toBeFalsy();

        const strokeLayer = subLayers.find(l => l.id.includes('stroke'));
        const fillLayer = subLayers.find(l => l.id.includes('fill'));

        expect(fillLayer.state.emptyTexture, 'should be enabled in composite layer').toBeTruthy();
        let uniforms = getLayerUniforms(fillLayer);
        expect(uniforms.patternMask, 'has patternMask uniform').toBeTruthy();
        expect(
          fillLayer.getAttributeManager().getAttributes().fillPatternScales.value,
          'fillPatternScales attribute is populated'
        ).toEqual([2]);
        expect(
          fillLayer.getAttributeManager().getAttributes().fillPatternFrames.value.slice(0, 4),
          'fillPatternFrames attribute is populated'
        ).toEqual([0, 0, 1, 1]);

        uniforms = getLayerUniforms(strokeLayer);
        expect(strokeLayer.state.emptyTexture, 'should not be enabled in PathLayer').toBeFalsy();
        expect('patternMask' in uniforms, 'should not be enabled in PathLayer').toBeFalsy();
      }
    },
    {
      title: `Finalizing a sublayer should not affect the parent layer's loaded props`,
      updateProps: {
        data: []
      },
      onAfterUpdate: ({layer}) => {
        expect(
          layer.props.fillPatternAtlas.handle,
          'fillPatternAtlas texture is not deleted'
        ).toBeTruthy();
      }
    }
  ];

  testLayer({Layer: PolygonLayer, testCases, onError: err => expect(err).toBeFalsy()});
});

webglTest('FillStyleExtension#pattern origin reduction', () => {
  // Past zoom 12 deck projects in offset mode, so commonOrigin is the viewport centre: a large
  // common-space value that the shader would otherwise reduce against a repeat five orders of
  // magnitude smaller, in fp32.
  const viewport = new WebMercatorViewport({
    longitude: -73.9843,
    latitude: 40.6717,
    zoom: 18,
    width: 800,
    height: 600
  });
  const scale = 2;
  const size = 32;
  const cell = FILL_UV_SCALE * scale * size;

  const render = (props: Record<string, unknown>) => {
    let uniforms;
    testLayer({
      Layer: PolygonLayer,
      viewport,
      testCases: [
        {
          props: {
            id: 'fill-pattern-origin',
            data: FIXTURES.polygons,
            getPolygon: d => d,

            fillPatternAtlas: FILL_PATTERN_ATLAS,
            fillPatternMapping: {
              a: {x: 0, y: 0, width: size, height: size},
              b: {x: size, y: 0, width: size, height: size}
            },
            getFillPattern: () => 'a',
            getFillPatternScale: scale,

            extensions: [new FillStyleExtension({pattern: true})],
            ...props
          },
          onAfterUpdate: ({subLayers}) => {
            uniforms = getLayerUniforms(subLayers.find(l => l.id.includes('fill')));
          }
        }
      ],
      onError: err => expect(err).toBeFalsy()
    });
    return uniforms;
  };

  // An accessor means instances can disagree on the repeat, so no single one of them can be
  // reduced against - this is also the reading of the unreduced origin the case below needs.
  const unreduced = render({getFillPatternScale: () => scale}).uvCoordinateOrigin as number[];
  expect(
    Math.abs(unreduced[0]),
    'a data-driven pattern scale leaves the origin in common space'
  ).toBeGreaterThan(cell);

  const {uvCoordinateOrigin, uvCoordinateOrigin64Low} = render({});
  const [x, y] = uvCoordinateOrigin as number[];

  expect(x, 'reduced origin x is within one repeat').toBeGreaterThanOrEqual(0);
  expect(x, 'reduced origin x is within one repeat').toBeLessThan(cell);
  expect(y, 'reduced origin y is within one repeat').toBeGreaterThanOrEqual(0);
  expect(y, 'reduced origin y is within one repeat').toBeLessThan(cell);

  // Only whole repeats were removed, so the pattern lands exactly where it did before.
  expect(x, 'reduction preserves the phase').toBeCloseTo(modFloor(unreduced[0], cell), 12);
  expect(y, 'reduction preserves the phase').toBeCloseTo(modFloor(unreduced[1], cell), 12);

  // A value this small is exact in fp32 - the 64-bit low part has nothing left to carry.
  const low = uvCoordinateOrigin64Low as number[];
  expect(Math.abs(low[0]), 'low part is spent').toBeLessThan(1e-10);
  expect(Math.abs(low[1]), 'low part is spent').toBeLessThan(1e-10);

  // Frames of differing sizes mean the repeat is per-instance again.
  const mixed = render({
    fillPatternMapping: {
      a: {x: 0, y: 0, width: size, height: size},
      b: {x: size, y: 0, width: size, height: size * 2}
    }
  }).uvCoordinateOrigin as number[];
  expect(
    Math.abs(mixed[0]),
    'differently sized frames leave the origin in common space'
  ).toBeGreaterThan(cell);
});
