import { fdeWeights } from "./weights.js";
console.log(fdeWeights.map((l, i) => ({ layer: i, name: l.name, weightsCols: l.weights[0].length })));
