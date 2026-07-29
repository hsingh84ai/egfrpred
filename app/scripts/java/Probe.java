/*
 * Ground-truth probe for the browser port.
 *
 * Reproduces exactly how PaDEL prepares a molecule before fingerprinting --
 * perceive atom types, add implicit hydrogens (without making them explicit),
 * then run CDK's Hueckel aromaticity detector -- and dumps the results the
 * TypeScript implementation has to match:
 *
 *   fp       the 881 PubChem bits, from PaDEL's own PubchemFingerprinter
 *   arom     indices of bonds CDK considers aromatic
 *   sssr     CDK's SSSR ring set, as atom indices
 *   smarts   whether a given SMARTS matches, for probing CDK query semantics
 *
 * Reads one molecule per line ("<smiles>\t<id>") on stdin, writes one JSON
 * object per line on stdout. Extra arguments are SMARTS to evaluate per
 * molecule, which is how the H-primitive and aromatic-bond questions get
 * settled by experiment rather than by reading bytecode.
 */

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.List;

import org.openscience.cdk.DefaultChemObjectBuilder;
import org.openscience.cdk.aromaticity.CDKHueckelAromaticityDetector;
import org.openscience.cdk.interfaces.IAtomContainer;
import org.openscience.cdk.interfaces.IBond;
import org.openscience.cdk.interfaces.IRingSet;
import org.openscience.cdk.ringsearch.SSSRFinder;
import org.openscience.cdk.smiles.SmilesParser;
import org.openscience.cdk.smiles.smarts.SMARTSQueryTool;
import org.openscience.cdk.tools.CDKHydrogenAdder;
import org.openscience.cdk.tools.manipulator.AtomContainerManipulator;

public class Probe {

    /** Mirrors libPaDELDescriptorWorker's preparation for the default CLI flags. */
    static void prepare(IAtomContainer mol) throws Exception {
        AtomContainerManipulator.percieveAtomTypesAndConfigureAtoms(mol);
        CDKHydrogenAdder.getInstance(mol.getBuilder()).addImplicitHydrogens(mol);
        // NOTE: convertImplicitToExplicitHydrogens is deliberately NOT called.
        // PaDEL only does that with -addhydrogens, which the original EGFRpred
        // command line never passes, so CDK sees a molecule with zero hydrogen
        // *atoms* even though implicit hydrogen counts are populated.
        CDKHueckelAromaticityDetector.detectAromaticity(mol);
    }

    static String quote(String s) {
        return '"' + s.replace("\\", "\\\\").replace("\"", "\\\"") + '"';
    }

    public static void main(String[] args) throws Exception {
        SmilesParser parser = new SmilesParser(DefaultChemObjectBuilder.getInstance());
        // A single leading "@file" argument reads patterns one per line, so all
        // 618 SMARTS can be probed at once.
        List<String> patterns = new ArrayList<>();
        if (args.length == 1 && args[0].startsWith("@")) {
            BufferedReader pf = new BufferedReader(new java.io.FileReader(args[0].substring(1)));
            for (String p = pf.readLine(); p != null; p = pf.readLine()) {
                if (!p.trim().isEmpty()) patterns.add(p);
            }
            pf.close();
        } else {
            for (String smarts : args) patterns.add(smarts);
        }
        List<SMARTSQueryTool> queries = new ArrayList<>();
        for (String smarts : patterns) {
            queries.add(new SMARTSQueryTool(smarts));
        }

        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
        StringBuilder out = new StringBuilder();
        for (String line = in.readLine(); line != null; line = in.readLine()) {
            if (line.trim().isEmpty()) continue;
            String[] parts = line.split("\t");
            String smiles = parts[0];
            String id = parts.length > 1 ? parts[1] : smiles;

            out.setLength(0);
            out.append("{").append(quote("id")).append(":").append(quote(id));
            try {
                IAtomContainer mol = parser.parseSmiles(smiles);
                prepare(mol);

                libpadeldescriptor.PubchemFingerprinter fp =
                        new libpadeldescriptor.PubchemFingerprinter();
                BitSet bits = fp.getFingerprint(mol);
                out.append(",").append(quote("fp")).append(":[");
                for (int i = bits.nextSetBit(0); i >= 0; i = bits.nextSetBit(i + 1)) {
                    if (out.charAt(out.length() - 1) != '[') out.append(",");
                    out.append(i);
                }
                out.append("]");

                out.append(",").append(quote("arom")).append(":[");
                for (int i = 0; i < mol.getBondCount(); i++) {
                    IBond bond = mol.getBond(i);
                    if (!bond.getFlag(org.openscience.cdk.CDKConstants.ISAROMATIC)) continue;
                    if (out.charAt(out.length() - 1) != '[') out.append(",");
                    out.append("[")
                       .append(mol.getAtomNumber(bond.getAtom(0)))
                       .append(",")
                       .append(mol.getAtomNumber(bond.getAtom(1)))
                       .append("]");
                }
                out.append("]");

                IRingSet rings = new SSSRFinder(mol).findSSSR();
                out.append(",").append(quote("sssr")).append(":[");
                for (IAtomContainer ring : rings.atomContainers()) {
                    if (out.charAt(out.length() - 1) != '[') out.append(",");
                    out.append("[");
                    for (int i = 0; i < ring.getAtomCount(); i++) {
                        if (i > 0) out.append(",");
                        out.append(mol.getAtomNumber(ring.getAtom(i)));
                    }
                    out.append("]");
                }
                out.append("]");

                if (!queries.isEmpty()) {
                    out.append(",").append(quote("smarts")).append(":[");
                    for (int i = 0; i < queries.size(); i++) {
                        if (i > 0) out.append(",");
                        boolean hit;
                        try {
                            hit = queries.get(i).matches(mol);
                        } catch (Exception e) {
                            hit = false;
                        }
                        out.append(hit ? 1 : 0);
                    }
                    out.append("]");
                }
            } catch (Exception e) {
                out.append(",").append(quote("error")).append(":")
                   .append(quote(String.valueOf(e.getMessage())));
            }
            out.append("}");
            System.out.println(out);
        }
    }
}
