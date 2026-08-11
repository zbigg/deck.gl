// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {ShaderModule} from '@luma.gl/shadertools';
import {project, fp64LowPart} from '@deck.gl/core';
import type {ProjectProps, ProjectUniforms} from '@deck.gl/core';

import type {Texture} from '@luma.gl/core';

const uniformBlock = /* glsl */ `\
layout(std140) uniform fillUniforms {
  vec2 patternTextureSize;
  bool patternEnabled;
  bool patternMask;
  vec2 uvCoordinateOrigin;
  vec2 uvCoordinateOrigin64Low;
} fill;
`;

/*
 * fill pattern shader module
 */
const patternVs = /* glsl */ `
in vec4 fillPatternFrames;
in float fillPatternScales;
in vec2 fillPatternOffsets;

out vec2 fill_uv;
out vec4 fill_patternBounds;
out vec4 fill_patternPlacement;
`;

const vs = `
${uniformBlock}
${patternVs}
`;

const patternFs = /* glsl */ `
uniform sampler2D fill_patternTexture;

in vec4 fill_patternBounds;
in vec4 fill_patternPlacement;
in vec2 fill_uv;

const float FILL_UV_SCALE = 512.0 / 40000000.0;
`;

const fs = `
${uniformBlock}
${patternFs}
`;

const inject = {
  'vs:DECKGL_FILTER_GL_POSITION': /* glsl */ `
    fill_uv = geometry.position.xy;
  `,

  'vs:DECKGL_FILTER_COLOR': /* glsl */ `
    if (fill.patternEnabled) {
      fill_patternBounds = fillPatternFrames / vec4(fill.patternTextureSize, fill.patternTextureSize);
      fill_patternPlacement.xy = fillPatternOffsets;
      fill_patternPlacement.zw = fillPatternScales * fillPatternFrames.zw;
    }
  `,

  'fs:DECKGL_FILTER_COLOR': /* glsl */ `
    if (fill.patternEnabled) {
      vec2 scale = FILL_UV_SCALE * fill_patternPlacement.zw;
      vec2 patternUV = mod(mod(fill.uvCoordinateOrigin, scale) + fill.uvCoordinateOrigin64Low + fill_uv, scale) / scale;
      patternUV = mod(fill_patternPlacement.xy + patternUV, 1.0);

      vec2 texCoords = fill_patternBounds.xy + fill_patternBounds.zw * patternUV;

      // The atlas cannot use REPEAT wrapping, so the repeat is emulated with mod() above.
      // That makes texCoords discontinuous at every repeat boundary, and an implicit LOD
      // reads those jumps as an enormous derivative and picks the coarsest mip - a seam.
      // Take the gradients from the continuous coordinate instead.
      vec2 gradX = fill_patternBounds.zw * (dFdx(fill_uv) / scale);
      vec2 gradY = fill_patternBounds.zw * (dFdy(fill_uv) / scale);

      vec4 patternColor = textureGrad(fill_patternTexture, texCoords, gradX, gradY);
      color.a *= patternColor.a;
      if (!fill.patternMask) {
        color.rgb = patternColor.rgb;
      }
    }
  `
};

/** Meters to common space. Mirrors FILL_UV_SCALE in the fragment shader above. */
export const FILL_UV_SCALE = 512 / 40000000;

export type FillStyleModuleProps = {
  project: ProjectProps;
  fillPatternEnabled?: boolean;
  fillPatternMask?: boolean;
  fillPatternTexture: Texture;
  /**
   * Size of one pattern repeat in common space, when every instance in the draw call shares it.
   * Lets the pattern origin be reduced on the CPU - see `getPatternUniforms`.
   */
  fillPatternCell?: [number, number] | null;
};

type FillStyleModuleUniforms = {
  patternTextureSize?: [number, number];
  patternEnabled?: boolean;
  patternMask?: boolean;
  uvCoordinateOrigin?: [number, number];
  uvCoordinateOrigin64Low?: [number, number];
};

type FillStyleModuleBindings = {
  fill_patternTexture?: Texture;
};

/** Floored remainder, matching GLSL `mod()`. JS `%` truncates toward zero. */
function modFloor(x: number, y: number): number {
  return x - y * Math.floor(x / y);
}

/* eslint-disable camelcase */
function getPatternUniforms(
  opts?: FillStyleModuleProps | {}
): FillStyleModuleBindings & FillStyleModuleUniforms {
  if (!opts) {
    return {};
  }
  const uniforms: FillStyleModuleBindings & FillStyleModuleUniforms = {};
  if ('fillPatternTexture' in opts) {
    const {fillPatternTexture} = opts;
    uniforms.fill_patternTexture = fillPatternTexture;
    uniforms.patternTextureSize = [fillPatternTexture.width, fillPatternTexture.height];
  }
  if ('project' in opts) {
    const {fillPatternMask = true, fillPatternEnabled = true, fillPatternCell = null} = opts;
    const projectUniforms = project.getUniforms(opts.project) as ProjectUniforms;
    const {commonOrigin} = projectUniforms;

    // `commonOrigin` spans the whole of common space (up to 512), while one pattern repeat is
    // on the order of 1e-5 common units when zoomed in. Reducing one against the other in the
    // shader loses the low bits of `scale * floor(origin / scale)`, which is a few screen
    // pixels of pattern phase past zoom 16 and doubles with every zoom level after that.
    //
    // Subtracting whole repeats does not change the phase, so when every instance shares a
    // repeat we can subtract them here instead, in fp64. The shader then receives a value
    // below one repeat, where its own `mod()` returns the value untouched.
    const coordinateOriginCommon: [number, number] = fillPatternCell
      ? [
          modFloor(commonOrigin[0], fillPatternCell[0]),
          modFloor(commonOrigin[1], fillPatternCell[1])
        ]
      : [commonOrigin[0], commonOrigin[1]];

    uniforms.uvCoordinateOrigin = coordinateOriginCommon;
    uniforms.uvCoordinateOrigin64Low = [
      fp64LowPart(coordinateOriginCommon[0]),
      fp64LowPart(coordinateOriginCommon[1])
    ];
    uniforms.patternMask = fillPatternMask;
    uniforms.patternEnabled = fillPatternEnabled;
  }
  return uniforms;
}

export const patternShaders = {
  name: 'fill',
  vs,
  fs,
  inject,
  dependencies: [project],
  getUniforms: getPatternUniforms,
  uniformTypes: {
    patternTextureSize: 'vec2<f32>',
    patternEnabled: 'i32',
    patternMask: 'i32',
    uvCoordinateOrigin: 'vec2<f32>',
    uvCoordinateOrigin64Low: 'vec2<f32>'
  }
} as const satisfies ShaderModule<
  FillStyleModuleProps,
  FillStyleModuleUniforms,
  FillStyleModuleBindings
>;
