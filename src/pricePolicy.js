function getUndercutStep(competitorPrice, minPrice, standardStep, nearFloorWindow) {
  const headroom = competitorPrice - minPrice;
  return headroom <= nearFloorWindow || headroom < standardStep ? 1 : standardStep;
}

module.exports = { getUndercutStep };
