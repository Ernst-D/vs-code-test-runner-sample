import * as vscode from "vscode";

const testRe = /^([0-9]+)\s*([+*/-])\s*([0-9]+)\s*=\s*([0-9]+)/;
const headingRe = /^(#+)\s*(.+)$/;

export const parseMarkdown = (
    text: string,
    events: {
        onTest(range: vscode.Range, a: number, operator: string, b: number, expected: number): void;
        onHeading(range: vscode.Range, name: string, depth: number): void;
    }
) => {
    const lines = text.split("\n");

    for(let lineIndex = 0; lineIndex < lines.length; lineIndex++){
        const line = lines[lineIndex];
        const test = testRe.exec(line);

        if(test){
            const [_, a, operator, b, expected] = test;
            const range = new vscode.Range(
                new vscode.Position(lineIndex,0), 
                new vscode.Position(lineIndex,test[0].length)
            );
            events.onTest(range, Number(a), operator, Number(b),Number(expected));
            continue;
        }

        const heading = headingRe.exec(line);
        if(heading) {
            const [, pounds, name] = heading;
            const range = new vscode.Range(new vscode.Position(lineIndex,0), new vscode.Position(lineIndex, line.length));
            events.onHeading(range, name, pounds.length);
        }
    }
}