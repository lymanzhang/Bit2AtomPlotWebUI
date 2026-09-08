import type { Path } from "flatten-svg";
import { elideShorterThan, merge as joinNearbyPaths, reorder as sortPaths } from "optimize-paths";
import { removeHiddenLines } from "./hiding.js";
import { computeStepsPerMm, getDevice, isBuiltinHardware, type Plan, type PlanOptions, plan } from "./planning.js";
import { alignToMargins, cropToMargins, dedupPoints, defaultPlacement, scaleToPaper } from "./util.js";
import { type Vec2, vmul, vrot } from "./vec.js";

// CSS, and thus SVG, defines 1px = 1/96th of 1in
// https://www.w3.org/TR/css-values-4/#absolute-lengths
const svgUnitsPerInch = 96;
const mmPerInch = 25.4;
const mmPerSvgUnit = mmPerInch / svgUnitsPerInch;

/**
 * Create a plan based on new vectors and plan options
 * @param inPaths
 * @param planOptions
 * @returns
 */
export function replan(inPaths: Path[], planOptions: PlanOptions): Plan {
  let paths: Vec2[][] = inPaths.map((path) => path.points);
  const device = getDevice(planOptions.hardware);
  const effectiveStepsPerMm = isBuiltinHardware(planOptions.hardware)
    ? device.stepsPerMm
    : computeStepsPerMm(planOptions.driveParams);

  // Rotate drawing around center of paper to handle plotting portrait drawings
  // along y-axis of plotter
  // Rotate around the center of the page, but in SvgUnits (not mm)
  if (planOptions.rotateDrawing !== 0) {
    console.time("rotating paths");
    paths = paths.map((pl) =>
      pl.map((p) =>
        vrot(
          p,
          vmul({ x: planOptions.paperSize.size.x / 2, y: planOptions.paperSize.size.y / 2 }, 1 / mmPerSvgUnit),
          planOptions.rotateDrawing,
        ),
      ),
    );
    console.timeEnd("rotating paths");
  }

  // Compute scaling using _all_ the paths, so it's the same no matter what
  // layers are selected.
  const placement = planOptions.placement ?? defaultPlacement;
  if (planOptions.fitPage) {
    paths = scaleToPaper(paths, planOptions.paperSize, planOptions.marginMm, placement);
  } else {
    paths = paths.map((ps) => ps.map((p) => vmul(p, mmPerSvgUnit)));
    paths = alignToMargins(paths, planOptions.paperSize, planOptions.marginMm, placement);
    if (planOptions.cropToMargins) {
      paths = cropToMargins(paths, planOptions.paperSize, planOptions.marginMm);
    }
  }

  // Rescaling loses the stroke info, so refer back to the original paths to
  // filter based on the stroke. Rescaling doesn't change the number or order
  // of the paths.
  //
  // NOTE: When hidden-line removal is enabled, layer filtering is deferred
  // until AFTER hidden-line removal so that fill paths from unselected layers
  // can still clip strokes from selected layers. Without this, selecting only
  // stroke layers (without their fill layers) would defeat hidden-line removal.
  const layerFilterEnabled = planOptions.layerMode === "group" || planOptions.layerMode === "stroke";
  const isLayerSelected = (originalIndex: number): boolean => {
    if (planOptions.layerMode === "group") {
      return planOptions.selectedGroupLayers.has(inPaths[originalIndex].groupId);
    }
    if (planOptions.layerMode === "stroke") {
      return planOptions.selectedStrokeLayers.has(inPaths[originalIndex].stroke);
    }
    return true;
  };

  if (layerFilterEnabled && !planOptions.hiding) {
    // No hidden-line removal: filter up front as before.
    if (planOptions.layerMode === "group") {
      paths = paths.filter((_path, i) => planOptions.selectedGroupLayers.has(inPaths[i].groupId));
    } else if (planOptions.layerMode === "stroke") {
      paths = paths.filter((_path, i) => planOptions.selectedStrokeLayers.has(inPaths[i].stroke));
    }
  }

  // Hidden-line removal
  if (planOptions.hiding) {
    // Build clippable array from ALL paths (not filtered by layer selection)
    // so that fill paths from unselected layers can still clip strokes.
    const clippable = inPaths.map((p, i) => ({
      points: paths[i],
      stroke: p.stroke ?? null,
      fill: p.fill ?? null,
      fillRule: p.fillRule ?? "nonzero",
      groupOrder: p.groupOrder ?? 0,
      originalIndex: i,
    }));
    clippable.sort((a, b) => (a.groupOrder ?? 0) - (b.groupOrder ?? 0));
    const result = removeHiddenLines(clippable);
    // Filter the result by layer selection now (after hidden-line removal).
    // Each result path carries the originalIndex of the path it came from.
    if (layerFilterEnabled) {
      const filtered = result.filter((p) => isLayerSelected(p.originalIndex));
      paths = filtered.map((p) => p.points);
    } else {
      paths = result.map((p) => p.points);
    }
  }

  if (planOptions.pointJoinRadius > 0) {
    paths = paths.map((p) => dedupPoints(p, planOptions.pointJoinRadius));
  }

  if (planOptions.sortPaths) {
    console.time("sorting paths");
    paths = sortPaths(paths);
    console.timeEnd("sorting paths");
  }

  if (planOptions.minimumPathLength > 0) {
    console.time("eliding short paths");
    paths = elideShorterThan(paths, planOptions.minimumPathLength);
    console.timeEnd("eliding short paths");
  }

  if (planOptions.pathJoinRadius > 0) {
    console.time("joining nearby paths");
    paths = joinNearbyPaths(paths, planOptions.pathJoinRadius);
    console.timeEnd("joining nearby paths");
  }

  // Convert the paths to units of "steps".
  paths = paths.map((ps) => ps.map((p) => vmul(p, effectiveStepsPerMm)));

  // And finally, motion planning.
  console.time("planning pen motions");
  const theplan = plan(
    paths,
    {
      penUpPos: device.penPctToPos(planOptions.penUpHeight),
      penDownPos: device.penPctToPos(planOptions.penDownHeight),
      penDownProfile: {
        acceleration: planOptions.penDownAcceleration * effectiveStepsPerMm,
        maximumVelocity: planOptions.penDownMaxVelocity * effectiveStepsPerMm,
        corneringFactor: planOptions.penDownCorneringFactor * effectiveStepsPerMm,
      },
      penUpProfile: {
        acceleration: planOptions.penUpAcceleration * effectiveStepsPerMm,
        maximumVelocity: planOptions.penUpMaxVelocity * effectiveStepsPerMm,
        corneringFactor: 0,
      },
      penDropDuration: planOptions.penDropDuration,
      penLiftDuration: planOptions.penLiftDuration,
    },
    vmul(planOptions.penHome, effectiveStepsPerMm),
  );
  console.timeEnd("planning pen motions");

  return theplan;
}
