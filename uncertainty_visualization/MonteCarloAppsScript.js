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
  nameColumn: 1,
  pointEstimateColumn: 2,
  parameterColumns: {
    quant05: 3,
    quant95: 4,
    distribution: 5,
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
  return [_colABCToNum(A1.match(/[A-Z]+/)), Number(A1.match(/\d+/))] // [col, row]
}

function offsetA1(A1, rowOffset, colOffset){
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
  let refSheet = reference.slice(0, max(0, reference.indexOf("!"))).replace("'", ""); //assumes that sheetName doesn't have "'"s, but that'd be silly
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
    [this._values, this._formulas] = this.getValuesAndFormulas(numHeaderRows);
    this.length = this._values.length;

    this.names = this._values.map((row) => row[assumptions.nameColumn]);
    this.pointEstimates = new Array(this.length);
    for(let row=0; row<this.length; row++){
      let formula = this._formulas[row][assumptions.pointEstimateColumn];
      let value = String(this._values[row][assumptions.pointEstimateColumn]);
      this.pointEstimates[row] = formula || ("="+value);
    }
    this.uncertaintyParameters = Array.from(new Array(this.length), () => new Object());
    for(let row=0; row<this.length; row++){
      Object.entries(assumptions.parameterColumns).forEach(([key, col]) => {
        this.uncertaintyParameters[row][key] = this._formulas[row][col] || this._values[row][col];
      });
    }
    this.isEstimateable = new Array(this.length);
    for(let row=0; row<this.length; row++){
      this.isEstimateable[row] = this._formulas[row][assumptions.pointEstimateColumn] == "";
      this.isEstimateable[row] &&= Object.values(this.uncertaintyParameters[row]).every((x) => x);
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
}

function makeRandomValuesSheet(spreadsheet, variableNames, iterations, sheetName){
  const randomValuesSheet = _newSheetByName(spreadsheet, sheetName);
  randomValuesSheet.getRange(1,1,variableNames.length,1).setValues(map(variableNames, (x) => [x]));
  randomValuesSheet.getRange(1,2,variableNames.length, iterations).setValues(randomArray(variableNames.length, iterations));
  return randomValuesSheet;
}

function makeInputValuesSheet(spreadsheet, inputs, iterations, newInputSheetName, newRandomValuesSheetName){
  const newInputsSheet = _newSheetByName(spreadsheet, newInputSheetName);
  newInputsSheet.getRange(1,1,1,iterations+1).setValues([["Iteration"]].concat(Array.from(Array(iterations), (v,k) => k+1).map((x) => [x])));
  newInputsSheet.getRange(2,1,inputs.length,1).setValues(map(inputs.names, (x) => [x]));

  function inputUpdateReference(reference, i){
    let rc = getReferenceComponents(reference);
    if(rc.refSheet){
      return reference; // Note that we don't support "forward" references to Computations or Outputs or internal references to Inputs
    } 
    if(Number(startCol) != assumptions.pointEstimateColumn){
      throw Error("Input formulas can only reference the point estimate column");
    }
    if(!rc.B2 && fromA1(rc.A1)[0] != fromA1(rc.B2)[0]){
      throw Error("Input formulas can only reference a single column");
    }
    
    return fromReferenceComponents({refSheet: "", 
                                    A1:offsetA1(rc.A1, 0, i), 
                                    B2: offsetA1(rc.B2, 0, i)});
  }

  let newFormulas = Array.from(new Array(inputs.length), () => []);
  for(let i = 0; i < iterations; i++) {
    for(let row=0; row<inputs.length; row++){
      if(inputs.isEstimateable[row]){
        newFormulas[row].push("="+normalDistribution(
          fromReferenceComponents({refSheet: newRandomValuesSheetName,
                                    A1: toA1(row, i+1),
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

function mc(iterations=10, randomValuesSheet=null) {
    const spreadsheet = SpreadsheetApp.getActive();
    const inputs = new UserSheet(spreadsheet, assumptions.sheetNames.inputs);
    const calculations = new UserSheet(spreadsheet, assumptions.sheetNames.calculations);
    const outputs = new UserSheet(spreadsheet, assumptions.sheetNames.outputs);

    const randomValuesSheet = randomValuesSheet || makeRandomValuesSheet(spreadsheet, inputs.names, iterations, "mc rand");
    const newInputsSheet  = _newSheetByName(spreadsheet, "mc inputs");
    const newCalculationSheet = _newSheetByName(spreadsheet, "mc calc");
    const newOutputsSheet = _newSheetByName(spreadsheet, "mc out");
  
    newInputsSheet.getRange(1,1,inputs.length,1).setValues(inputs.names);
    let newFormulas = Array.from(new Array(inputs.length), () => []);
  

  
    // TODO: the following code doesn't work for ranges (A1:B2, say)
  
  
    for(let i = 0; i < iterations; i++) {
      for(let row = 0; row < inputNames.length; row++){
        if(inputs.formulas[row][1]) { 
          let f = inputs.formulas[row][1].replace(regex, (s) => { 
            if(s.includes("\!")){ 
              // then this is a reference to another sheet, no change is needed
              return s;
            }
            let toNewCoordinates = (str) => {
              let noDollar = str.replace("$", "");
              if(!/^B\d+$/.test(noDollar)){ //TODO: magic "B"
                throw EvalError("Can only use formulas that reference other sheets or the B column");
              }
              return toA1(Number(noDollar.substring(1))-1, i+2)
            }
            return s.split(":").map(toNewCoordinates).join(":")
          });
          
          newFormulas[row].push(f);
        }
        else{
          let [name, expected, minimum, maximum] = inputs.values[row];
          if(!minimum || !maximum || Number(minimum) == Number(maximum)){
            newFormulas[row].push(expected);
          } else {
            newFormulas[row].push("=NORMINV('"+randomValuesSheet.getName()+"'!"+toA1(row+1, i+2)+", "+ expected + ", "+ (maximum-minimum)/(1.96*2) +")") //TODO: replace this with custom distribution
          }
        }
      }
    }
  
    newInputsSheet.getRange(1,2,inputNames.length, iterations).setFormulas(newFormulas);
  
  
    const calculationsSheet = spreadsheet.getSheetByName("Calculations");
    const calculation = calculationsSheet.getDataRange();
    const calculationValues = calculation.getValues().slice(1);
    const calculationFormulas = calculation.getFormulas().slice(1);
    const numYears = calculationValues[0].length - 1;
  
    const calculationNames = calculationValues.map((l) => l[0]);
    const flattenCalculationNames = Array.from(Array(numYears), (v,k) => k+1).reduce((x,y) => x.concat(calculationNames.map((n) => y + "_" + n)), []);
    
    function updatedFormula(i, formula, value){
      if(formula){
        return formula.replace(regex, (s) => {
          if(s.includes("\!")){
            let [sheetName, loc] = s.split("!").map((st) => st.replace("'", "")); //assumes that sheetName doesn't have "'"s, but that'd be silly
            if(sheetName == inputs.sheetName){ // this uses a variable from "Inputs", so we need to change it to reference the previous calculations
              let [col, row] = [String(loc.match(/[A-Z]+/)), Number(loc.match(/\d+/))];
              if(col!="B"){
                throw EvalError("referenced column '"+col+"' in 'inputs', which is not B");
              }
              return "'" + newInputsSheet.getName() + "'!" + toA1(row-1, i+2);
            } else {
              if (sheetName == calculationsSheet.getName()){
                throw Error("why do you reference your own sheet?")
              } else {
                return s;
              }
            }          
          }
          else { // this cell references another computation
            let [col, row] = [String(s.match(/[A-Z]+/)), Number(s.match(/\d+/))];
            let colNum = _colABCToNum(col);
            let newRow = row - 1 + (colNum-1-1)*calculationNames.length
            return toA1(newRow, i+2)           
          }
        })
      } else {
        return value
      }
    }
  
    let newCalculationFormulas = Array.from(new Array(flattenCalculationNames.length), () => []);
  
    for(let i=0; i<iterations; i++){
      for(let row=0; row<calculationNames.length; row++){
        for(let year = 1; year <= numYears; year++){
          let newformula = updatedFormula(i, calculationFormulas[row][year], calculationValues[row][year]);
          newCalculationFormulas[row + (year-1)*calculationNames.length].push(newformula);
        }
      }
    }
  
    newCalculationSheet.getRange(1, 1, flattenCalculationNames.length).setValues(flattenCalculationNames.map(x => [x]));
    newCalculationSheet.getRange(1, 2, flattenCalculationNames.length, iterations).setFormulas(newCalculationFormulas);
  
    const outputsSheet = spreadsheet.getSheetByName("Outputs");
    const outputs = outputsSheet.getDataRange();
    const outputsValues = outputs.getValues().slice(1);
    const outputsNames = outputsValues.map((l) => l[0]);
    const outputsFormulas = outputs.getFormulas().slice(1);
  
  
    function updateOutputsFormula(i, formula, value){
      if(!formula){
        return value;
      }
      return formula.replace(regex, (s) => {
        if(s.includes("\!")){
          let [sheetName, loc] = s.split("!").map((st) => st.replace("'", "")); //assumes that sheetName doesn't have "'"s, but that'd be silly
          if(sheetName == inputsSheet.getName()){ // this uses a variable from "Inputs", so we need to change it to reference the previous calculations
            let [col, row] = [String(loc.match(/[A-Z]+/)), Number(loc.match(/\d+/))];
            if(col!="B"){
              throw EvalError("referenced column '"+col+"' in 'inputs', which is not B");
            }
            return "'" + newInputsSheet.getName() + "'!" + toA1(row-1, i+2);
          } else {
            if (sheetName == calculationsSheet.getName()){
              if(loc.includes(":")){
                let [[col1, row1], [col2, row2]] = loc.split(":").map(fromA1);
                if(row1 != row2){
                  throw Error("can't do this yet");
                }
                return 'FILTER('+"'"+newCalculationSheet.getName()+"'!"+_colNumToABC(i+2)+":"+_colNumToABC(i+2)+', REGEXMATCH('+"'"+newCalculationSheet.getName()+"'!"+"A:A"+',"'+escapeRegExp(calculationNames[row1-2])+'$"))'
              }
              else{
                throw Error("this, also, could be implemented");
              }
            } else {
              return s;
            }
          }          
        }
        else { // this cell references another in the same sheet
          let [col, row] = [String(s.match(/[A-Z]+/)), Number(s.match(/\d+/))];
          let colNum = _colABCToNum(col); //should be B
          let newRow = row - 1
          return toA1(newRow, i+2)           
        }
      });
    }
    
    let newOutputsFormulas = Array.from(new Array(outputsValues.length), () => []);
  
    for(let i=0; i<iterations; i++){
      for(let row=0; row<outputsValues.length; row++){
        newOutputsFormulas[row].push(updateOutputsFormula(i, outputsFormulas[row][1], outputsValues[row][1]));
      }
    }  
  
    newOutputsSheet.getRange(1,1,outputsNames.length).setValues(outputsNames.map((x) => [x]));
    newOutputsSheet.getRange(1,2,newOutputsFormulas.length, iterations).setFormulas(newOutputsFormulas);
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
  
  
  
