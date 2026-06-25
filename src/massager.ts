import type { Path } from "flatten-svg";
import { elideShorterThan, merge as joinNearbyPaths, reorder as sortPaths } from "optimize-paths";
import { Device, type Plan, type PlanOptions, plan, computeStepsPerMm, isBuiltinHardware } from "./planning.js";
import { cropToMargins, dedupPoints, scaleToPaper } from "./util.js";
import { type Vec2, vmul, vrot } from "./vec.js";
import { removeHiddenLines } from "./hiding.js";

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
  const device = Device(planOptions.hardware);
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
  if (planOptions.fitPage) {
    paths = scaleToPaper(paths, planOptions.paperSize, planOptions.marginMm);
  } else {
    paths = paths.map((ps) => ps.map((p) => vmul(p, mmPerSvgUnit)));
    if (planOptions.cropToMargins) {
      paths = cropToMargins(paths, planOptions.paperSize, planOptions.marginMm);
    }
  }

  // Rescaling loses the stroke info, so refer back to the original paths to
  // filter based on the stroke. Rescaling doesn't change the number or order
  // of the paths.
  if (planOptions.layerMode === "group") {
    paths = paths.filter((_path, i) => planOptions.selectedGroupLayers.has(inPaths[i].groupId));
  } else if (planOptions.layerMode === "stroke") {
    paths = paths.filter((_path, i) => planOptions.selectedStrokeLayers.has(inPaths[i].stroke));
  }

  // Hidden-line removal
  if (planOptions.hiding) {
    var filteredInPaths = inPaths.filter(function(_p, i) {
      if (planOptions.layerMode === "group") return planOptions.selectedGroupLayers.has(inPaths[i].groupId);
      if (planOptions.layerMode === "stroke") return planOptions.selectedStrokeLayers.has(inPaths[i].stroke);
      return true;
    });
    var clippable = filteredInPaths.map(function(p, i) {
      return {
        points: paths[i],
        stroke: p.stroke ?? null,
        fill: p.fill ?? null,
        fillRule: p.fillRule ?? "nonzero",
        groupOrder: p.groupOrder ?? 0,
      };
    });
    clippable.sort(function(a, b) { return (a.groupOrder ?? 0) - (b.groupOrder ?? 0); });
    var result = removeHiddenLines(clippable);
    paths = result.map(function(p) { return p.points; });
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
