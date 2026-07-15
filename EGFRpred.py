from sklearn.ensemble import RandomForestClassifier
import csv_io
import cPickle
import sys
import os
import numpy as np

if len(sys.argv) != 3:
    sys.exit('Usage: %s Enter two arguments. First argument file having query smiles and second argument is output file' % sys.argv[0])

print "Running egfpred_standard_alone.jar-----please wait!"
#egfrpred_standard_alone options
javaoption = '-Xmx1024M'
jarfile = 'PaDEL-Descriptor.jar'
padeloptions = '-fingerprints -descriptortypes descriptors.xml -dir'
java_outfile = '-file egfrpred_out'
inputfile=sys.argv[1]

#egfrpred runing padel for descriptor calculation
cmd_run_jar = ' '.join(['java',javaoption,'-jar',jarfile,padeloptions,inputfile,java_outfile])
print "Running egfrpred_standard_alone.jar-----initiating fingerprint calculation"
os.system(cmd_run_jar)

#reading important fingerprints
ins1 = open("imp-no", "r" )
arrf = []
for line in ins1:
    arrf.append( line )
ins1.close()
flen = len(arrf)

#filtering important fingerprints
ins = open("egfrpred_out", "r" )
array = []
for line in ins:
    array.append( line )
ins.close()
qid = []
tlen = len(array)
f=open('queryfp','w')
for x in range(1,tlen):
	finger = array[x].rstrip()
	arr = finger.split(',')
	na = arr[0]
	qid.append(na)
	query = []
	for y in range(flen):
		z = int(arrf[y].rstrip())
		s = arr[z]
		if s == "":
			s = "0"
		query.append(s)
	fpq = ','.join(query)
	f.write(fpq) 	
	f.write("\n")
f.close()
zlen=len(qid)

#read in the query file
realtest = csv_io.read_data("queryfp")
test = [x[0:49] for x in realtest]

#loading model
with open('model', 'rb') as f:
    rf = cPickle.load(f)


# run model against test data and writing result file
predicted_probs = rf.predict_proba(test)
fx = open(sys.argv[2],'w')
header = '#Molecule_ID,Prediction,Prediction_score';
fx.write("%s\n" %(header))
arrs = []

for z in range(0,zlen):
	idv = qid[z] 
	idna = idv.replace("\"", "");
	fx.write(idna) 
	fx.write(",")
	valx = predicted_probs[z]
	sa = str(valx[1])
	if sa >= "0.2":
		fx.write("Anti-EGFR,")
	else:
		fx.write("Non-anti-EGFR,")
	fx.write("%s\n" %(sa))
fx.close()
os.remove('egfrpred_out')
os.remove('queryfp')
