/** @OnlyCurrentDoc */

// This regular expression is supposed to capture all the references to other cells - https://www.get-digital-help.com/extract-cell-references-from-a-formula/ [they have bugs there, so I fixed it hopefully]. It may be easier to use R1C1 notation. Only supports sheet names wrapped in "'"s or a singlewordwithonlylettersandnumbers.
const regex = /(('.{1,99}'!)|([a-zA-Z0-9]{1,99}!))?\$?[a-zA-Z]{1,3}\$?[0-9]{1,7}(:\$?[a-zA-Z]{0,3}\$?[0-9]{1,7})?/g
const abc = "_ABCDEFGHIJKLMNOPQRSTUVWXYZ";



function _newSheetByName(spreadsheet, name, color="orange", separator=" - ", timeFormat="yyyy-MM-dd HH:mm:ss") {
  const timezone = "GMT+" + new Date().getTimezoneOffset()/60;
  const date = Utilities.formatDate(new Date(), timezone, timeFormat);
  const newSheet = spreadsheet.insertSheet(name + separator + date, spreadsheet.getNumSheets());
  newSheet.setTabColor(color);
  return newSheet;
}

function _getValuesAndFormulas(sheet, range=null) {
  // TODO: add an option to manually specify a range (o/w "junk cells" may be included)
  let dr;
  if(range === null){
    dr = sheet.getDataRange();
  } else {
    dr = sheet.getRange(range);
  }
  const values = dr.getValues();
  const formulas = dr.getFormulas();
  return [values, formulas];
}

let assumptions = {
  numHeaderRows: 1,
  nameColumn: 0,
  pointEstimateColumn: 1,
  parameterColumns: {
    quant05: 2,
    quant95: 3,
    distribution: 4,
  },
  sheetNames: {
    inputs: "Inputs",
    calculations: "Calculations",
    outputs: "Outputs",
  }
}

function normalDistribution(randomSeed, pointEstimate, quant05, quant95){
  if(pointEstimate == null){
    pointEstimate = (quant05 + quant95)/2;
  }
  return "NORMINV(" + randomSeed + ", " + pointEstimate + ", " + (quant95-quant05)/(1.96*2) + ")";
}

function _colNumToABC(col){
  let s = "";
  while(col > 0){
    s = abc[((col-1) % 26) + 1] + s;
    col = Math.floor((col-1) / 26);
  }
  return s
}

function _colABCToNum(col){
  let n = 0;
  for(let char of col){
    n = n * 26;
    n = n + abc.search(char);
  }
  return n
}

function toA1(row, col){ // note that both col and row start from 1
  return _colNumToABC(col) + row;
}

function fromA1(A1){
  return [_colABCToNum(String(A1.match(/[A-Z]+/)) || ""), Number(A1.match(/\d+/) || "")] // [col, row]
}

function offsetA1(A1, rowOffset, colOffset){
  if(!A1){
    return A1;
  }
  let [col, row] = fromA1(A1);
  newRow = row == 0 ? 0 : row+rowOffset;
  newCol = col == 0 ? 0 : col+colOffset;
  return toA1(newRow, newCol);
}


function escapeRegExp(string) { // https://stackoverflow.com/questions/3446170/escape-string-for-use-in-javascript-regex/6969486#6969486
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}


function getReferenceComponents(reference){ // reference is a string like "'Sheet Name'!B2" or "B2:C3"
  let range = reference.split("!")[1] || reference;
  let refSheet = reference.slice(0, Math.max(0, reference.indexOf("!"))).replace("'", ""); //assumes that sheetName doesn't have "'"s, but that'd be silly
  let [start, end] = range.split(":"); // if there's no ":" then end will be undefined, and we return ""

  return {refSheet: refSheet, A1: start, B2: (end || "")};
}

function fromReferenceComponents(rc){
  return (rc.refSheet? "'" + rc.refSheet + "'!" : "") + rc.A1 + (rc.B2 ? ":" + rc.B2 : "");
}

function replaceFormulaReferences(str, f){
  return str.replace(regex, f);
}

class UserSheet{
  constructor(spreadsheet, name){
    this.spreadsheet = spreadsheet;
    this.sheetName = name;
    
    this.sheet = spreadsheet.getSheetByName(name);
    [this._values, this._formulas] = this.getValuesAndFormulas(assumptions.numHeaderRows);
    this.formulas = this._formulas.map((row, index) => row.map((cell, col) => cell || ("="+String(this._values[index][col]))));
    this.length = this._values.length;
    this.numRows = this._values[0].length;

    this.names = this._values.map((row) => row[assumptions.nameColumn]);
    this.pointEstimates = new Array(this.length);
    for(let row=0; row<this.length; row++){
      let value = String(this._values[row][assumptions.pointEstimateColumn]);
      this.pointEstimates[row] = value;
    }
    this.uncertaintyParameters = Array.from(new Array(this.length), () => new Object());
    for(let row=0; row<this.length; row++){
      Object.entries(assumptions.parameterColumns).forEach(([key, col]) => {
        this.uncertaintyParameters[row][key] = String(this._values[row][col]);
      });
    }
    this.isEstimateable = new Array(this.length);
    for(let row=0; row<this.length; row++){
      this.isEstimateable[row] = Object.values(this.uncertaintyParameters[row]).every((x) => x);
    }
  }

  getValuesAndFormulas(numHeaderRows, range=null) {
    let dr;
    if(range === null){
      dr = this.sheet.getDataRange();
    } else {
      dr = this.sheet.getRange(range); //TODO: test this!
    }
    const values = dr.getValues().slice(numHeaderRows);
    const formulas = dr.getFormulas().slice(numHeaderRows);
    return [values, formulas];
  }

  getName(){
    return this.sheetName;
  }
}

function makeHeader(iterations){
  return [["iteration:"].concat(Array.from(new Array(iterations), (v,k) => k+1))];
}

function makeRandomValuesSheet(spreadsheet, variableNames, iterations, sheetName){
  const randomValuesSheet = _newSheetByName(spreadsheet, sheetName);
  randomValuesSheet.getRange(1,1,1,iterations+1).setValues(makeHeader(iterations));
  randomValuesSheet.getRange(2,1,variableNames.length,1).setValues(variableNames.map((x) => [x]));
  randomValuesSheet.getRange(2,2,variableNames.length, iterations).setValues(randomArray(variableNames.length, iterations));
  return randomValuesSheet;
}

function inputUpdateReference(reference, i){
  let rc = getReferenceComponents(reference);
  if(rc.refSheet){
    return reference; // Note that we don't support "forward" references to Computations or Outputs or internal references to Inputs
  } 
  if(Number(fromA1(rc.A1)[0]) != assumptions.pointEstimateColumn + 1){
    throw Error("Input formulas can only reference the point estimate column");
  }
  if(rc.B2 && fromA1(rc.A1)[0] != fromA1(rc.B2)[0]){
    throw Error("Input formulas can only reference a single column");
  }
  
  return fromReferenceComponents({refSheet: "", 
                                  A1:offsetA1(rc.A1, 0, i), 
                                  B2: offsetA1(rc.B2, 0, i)});
}

function makeInputValuesSheet(spreadsheet, inputs, iterations, newInputSheetName, newRandomValuesSheetName){
  const newInputsSheet = _newSheetByName(spreadsheet, newInputSheetName);
  newInputsSheet.getRange(1,1,1,iterations+1).setValues(makeHeader(iterations));
  newInputsSheet.getRange(2,1,inputs.length,1).setValues(inputs.names.map((x) => [x]));

  let newFormulas = Array.from(new Array(inputs.length), () => []);
  for(let i = 0; i < iterations; i++) {
    for(let row=0; row<inputs.length; row++){
      if(inputs.isEstimateable[row]){
        newFormulas[row].push("="+normalDistribution(
          fromReferenceComponents({refSheet: newRandomValuesSheetName,
                                    A1: toA1(row+2, i+2),
                                    B2: ""}),
          inputs.pointEstimates[row],
          inputs.uncertaintyParameters[row].quant05,
          inputs.uncertaintyParameters[row].quant95
        ))
      } else {
        newFormulas[row].push(replaceFormulaReferences(inputs.formulas[row][assumptions.pointEstimateColumn], (s) => inputUpdateReference(s, i)));
      }
    }
  }
  newInputsSheet.getRange(2,2,inputs.length,iterations).setValues(newFormulas);
  return newInputsSheet
}

function flattenReindexedRow(row, col, numRows){
  return row + (col-1)*numRows;
}

function makeCalculationSheet(spreadsheet, calculations, iterations, newCalculationSheetName, inputsSheetName, newInputsSheetName){
  const newCalculationSheet = _newSheetByName(spreadsheet, newCalculationSheetName);
  const numYears = calculations.numRows - 1;
  
  newCalculationSheet.getRange(1,1,1,iterations+1).setValues(makeHeader(iterations));
  newCalculationSheet.getRange(2,1,calculations.length*numYears,1).setValues(Array.from(Array(numYears), (v,k) => k+1).reduce((x,y) => x.concat(calculations.names.map((name) => [y + "_" + name])), []));
  
  let newFormulas = Array.from(new Array(calculations.length*numYears), () => []);
  for(let i = 0; i < iterations; i++) {
    for(let row=0; row<calculations.length; row++){
      for(let year = 1; year <= numYears; year++){
        newFormulas[flattenReindexedRow(row, year, calculations.length)].push(replaceFormulaReferences(calculations.formulas[row][year], (s) => {
          let rc = getReferenceComponents(s);
          if(rc.refSheet == inputsSheetName){
            return fromReferenceComponents({refSheet: newInputsSheetName,
              A1: inputUpdateReference(s.split("!")[1], i),
              B2: ""});
          }
          if(rc.refSheet){
            return s; // Note that we don't support "forward" references to Outputs or internal references 
          }
          if(rc.B2){
            throw Error("Can't reference a range in a calculation (yet)");
          }
          let [_col, _row] = fromA1(rc.A1);
          return fromReferenceComponents({refSheet: "",
                                          A1: toA1(flattenReindexedRow(_row, _col-1, calculations.length), i+2),
                                          B2: ""});
        }));
      }
    }
  }
  newCalculationSheet.getRange(2,2,calculations.length*numYears, iterations).setFormulas(newFormulas);
  return newCalculationSheet;
}

function makeOutputsSheet(spreadsheet, outputs, iterations, newOutputsSheetName, calculations, newCalculationsSheetName, inputsSheetName, newInputsSheetName){
  const newOutputsSheet = _newSheetByName(spreadsheet, newOutputsSheetName);
  newOutputsSheet.getRange(1,1,1,iterations+1).setValues(makeHeader(iterations));
  newOutputsSheet.getRange(2,1,outputs.length,1).setValues(outputs.names.map((x) => [x]));

  let newFormulas = Array.from(new Array(outputs.length), () => []);
  for(let i = 0; i < iterations; i++) {
    for(let row = 0; row < outputs.length; row++){
      // the following assumes that the values are at column B
      newFormulas[row].push(replaceFormulaReferences(outputs.formulas[row][1], (s) => {
        let rc = getReferenceComponents(s);
        if(rc.refSheet == inputsSheetName){
          return fromReferenceComponents({refSheet: newInputsSheetName,
            A1: inputUpdateReference(s.split("!")[1], i),
            B2: ""});        }
        if(rc.refSheet == calculations.getName()){ //TODO: these sort of logic should go under "calculation sheet"
          if(rc.B2){
            if(fromA1(rc.A1)[1] != fromA1(rc.B2)[1]){
              throw Error("multi row call to calculation sheets not implemented yet. You can hack away at this by adding some rows in the calculations sheet and calling to them.")
            }
            return 'FILTER('+"'"+newCalculationsSheetName+"'!"+_colNumToABC(i+2)+":"+_colNumToABC(i+2)+', REGEXMATCH('+"'"+newCalculationsSheetName+"'!"+"A:A"+',"'+escapeRegExp(calculations.names[fromA1(rc.A1)[1]-2])+'$"))'

          }
          let [col, row] = fromA1(rc.A1);
          return fromReferenceComponents({refSheet: newOutputsSheetName,
                                          A1: toA1(row, i+2),
                                          B2: ""});
        }
        if(rc.refSheet){
          return s;
        }
        if(rc.B2){
          throw Error("Can't reference a range in a calculation (yet)");
        }
        if(rc.A1 != s){
          throw Error("I made a mistake :(");
        }
        return offsetA1(rc.A1, 0, i);
      }));
    }
  }
  newOutputsSheet.getRange(2,2,outputs.length, iterations).setFormulas(newFormulas);
  return newOutputsSheet;
}

function mc(iterations=100) {
  const spreadsheet = SpreadsheetApp.getActive();
  const inputs = new UserSheet(spreadsheet, assumptions.sheetNames.inputs);
  const calculations = new UserSheet(spreadsheet, assumptions.sheetNames.calculations);
  const outputs = new UserSheet(spreadsheet, assumptions.sheetNames.outputs);

  const randomValuesSheet = makeRandomValuesSheet(spreadsheet, inputs.names, iterations, "mc rand");
  const newInputsSheet  = makeInputValuesSheet(spreadsheet, inputs, iterations, "mc inputs", randomValuesSheet.getName());
  const newCalculationSheet = makeCalculationSheet(spreadsheet, calculations, iterations, "mc calc", inputs.getName(), newInputsSheet.getName());
  const newOutputsSheet = makeOutputsSheet(spreadsheet, outputs, iterations,  "mc out", calculations, newCalculationSheet.getName(), inputs.getName(), newInputsSheet.getName());
}
  
function randomArray(numRows, numColumns) {
  let arr = Array(numRows).fill()
          .map(() => 
            Array(numColumns).fill()
            .map(() => Math.random())
          )
  return arr;
}

function deleteAllmcRuns() {
  spreadsheet = SpreadsheetApp.getActive();
  allSheets = spreadsheet.getSheets().forEach((sheet) => {
    if(sheet.getName().startsWith("mc ")) {
      spreadsheet.deleteSheet(sheet)
    }
  })
}

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('Monte Carlo')
      .addItem('Run in a new sheet', 'mc')
      .addItem('Remove all previous runs', 'deleteAllmcRuns')
  .addToUi();
};
  
  
  
