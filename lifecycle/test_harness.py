import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from control import armed, joins, same_process, smoke_matches, terminal
from identity import LEAVES
from compose import compose
from run import Session, complete_diagnostic


def lines(rows):
    return b''.join((json.dumps(dict(r,schema=1,run='unit',seq=i))+'\n').encode() for i,r in enumerate(rows))


def fixture():
    parent={'volume':'0000000000000001','fileId':'a'*32,'ntPath':r'\Device\HarddiskVolume4\temp\npm\node_modules'}
    baseline={leaf:dict(parent,fileId=str(i+1)*32,ntPath=parent['ntPath']+'\\openclaw\\'+leaf) for i,leaf in enumerate(LEAVES)}
    binding={'run':'unit','harnessPid':42,'harnessCreated100ns':'111','harnessExecutable':r'C:\pwsh.exe'}
    rows=[{'kind':'start','observerPid':99,'binding':dict(binding,bindingSha256='abc')},
          {'kind':'harness','identity':{'created100ns':'111','executable':r'C:\pwsh.exe','exited100ns':'0','nativeMachine':0x8664}},
          {'kind':'package-parent','file':parent},
          *[{'kind':'baseline','leaf':leaf,'file':baseline[leaf]} for leaf in LEAVES],
          {'kind':'armed','baseline':baseline,'parentNt':parent['ntPath']}]
    return rows,binding,{'pid':99},parent


class Controls(unittest.TestCase):
    def setUp(self): self.rows,self.binding,self.observer,self.parent=fixture()
    def admit(self): return armed(lines(self.rows),self.binding,'abc',self.observer,self.parent)
    def end(self): return self.rows+[{'kind':'settled','armed':True,'reason':'sample-limit'}]
    def test_valid_arm(self): self.assertEqual(set(self.admit()['baseline']),set(LEAVES))
    def test_missing_arm(self):
        self.rows.pop()
        with self.assertRaises(ValueError): self.admit()
    def test_wrong_binding(self):
        self.rows[0]['binding']['bindingSha256']='other'
        with self.assertRaises(ValueError): self.admit()
    def test_reused_harness_pid(self):
        self.rows[1]['identity']['created100ns']='222'
        with self.assertRaises(ValueError): self.admit()
    def test_missing_leaf(self):
        self.rows[-1]['baseline'].pop(LEAVES[0])
        with self.assertRaises(ValueError): self.admit()
    def test_cross_leaf_alias(self):
        self.rows[-1]['baseline'][LEAVES[0]]['ntPath']=self.rows[-1]['baseline'][LEAVES[1]]['ntPath']
        with self.assertRaises(ValueError): self.admit()
    def test_wrong_parent(self):
        self.parent=copy.deepcopy(self.parent); self.parent['fileId']='b'*32
        with self.assertRaises(ValueError): self.admit()
    def test_observer_pid(self):
        self.observer={'pid':100}
        with self.assertRaises(ValueError): self.admit()
    def test_early_settlement(self):
        self.rows=self.end()
        with self.assertRaises(ValueError): self.admit()
    def test_truncated_arming(self):
        with self.assertRaises(ValueError): armed(lines(self.rows)[:-1],self.binding,'abc',self.observer,self.parent)
    def test_valid_terminal(self): self.assertEqual(len(terminal(lines(self.end()),self.binding,'abc',0,99)),7)
    def test_terminal_requires_actual_arming(self):
        rows=self.end(); rows.pop(-2)
        with self.assertRaises(ValueError): terminal(lines(rows),self.binding,'abc',0,99)
    def test_terminal_requires_observer_identity(self):
        rows=self.end(); rows[0]['observerPid']=None
        with self.assertRaises(ValueError): terminal(lines(rows),self.binding,'abc',0,99)
    def test_truncated_terminal(self):
        with self.assertRaises(ValueError): terminal(lines(self.end())[:-1],self.binding,'abc',0,99)
    def test_unsettled_exit(self):
        with self.assertRaises(ValueError): terminal(lines(self.end()),self.binding,'abc',None,99)
    def test_nonzero_exit(self):
        with self.assertRaises(ValueError): terminal(lines(self.end()),self.binding,'abc',2,99)
    def test_missing_terminal(self):
        with self.assertRaises(ValueError): terminal(lines(self.rows),self.binding,'abc',0,99)
    def test_output_cap_error(self):
        rows=self.end(); rows[-1]['reason']='output-budget'
        with self.assertRaises(ValueError): terminal(lines(rows),self.binding,'abc',0,99)
    def test_sequence_gap(self):
        with self.assertRaises(ValueError): terminal(lines(self.end()).replace(b'"seq": 2',b'"seq": 9'),self.binding,'abc',0,99)
    def test_pid_reuse_mapping_join(self):
        ident={'pid':17,'created100ns':'55','executable':r'C:\node.exe'}
        self.assertEqual(joins([{'kind':'mapping','pid':17,'processIdentity':dict(ident,created100ns='44')}],ident),[])
        self.assertFalse(same_process(dict(ident,executable=r'C:\other.exe'),ident))
    def test_empty_smoke(self):
        with self.assertRaises(ValueError): smoke_matches([],{},self.rows[-1]['baseline'])
    def test_positive_smoke_and_replacement(self):
        ident={'pid':17,'created100ns':'55','executable':r'C:\python.exe'}; base=self.rows[-1]['baseline']
        rows=[{'kind':'mapping','pid':17,'processIdentity':ident,'raw':{'type':0x40000,'reopenedFile':base[leaf]},
               'correlation':{'scope':'exact-leaf-path','identity':'same-file-id-at-reopened-path','leaf':leaf}} for leaf in LEAVES]
        self.assertEqual(smoke_matches(rows,ident,base),sorted(LEAVES))
        rows[0]['raw']['reopenedFile']=dict(base[LEAVES[0]],fileId='c'*32)
        with self.assertRaises(ValueError): smoke_matches(rows,ident,base)
    def test_composition(self):
        text=compose(Path('upstream.ps1').read_text())
        for forbidden in ["Invoke-ProofCommand -Name 'published-driver-update'", "Invoke-ProofCommand -Name 'candidate-doctor'",'Remove-Item -LiteralPath $root -Recurse']:
            self.assertNotIn(forbidden,text)
        self.assertIn('ArgumentList.Add($arg)',text)
        with self.assertRaises(ValueError): compose(Path('upstream.ps1').read_text().replace('-Seconds 3600','-Seconds 4000'))
    def test_launch_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            s=Session(Mock(),Path(tmp)/'evidence',1)
            with patch('run.subprocess.Popen',side_effect=OSError('fixture launch denial')):
                with self.assertRaises(OSError): s.launch('observer',['missing.exe'],tmp)
            self.assertEqual(s.result['commands'][0]['launch'],'failed'); self.assertEqual(s.children,[])
    def test_unsettled_not_killed(self):
        with tempfile.TemporaryDirectory() as tmp:
            s=Session(Mock(),Path(tmp)/'evidence',0); child=Mock();child.poll.return_value=None;s.children=[(child,{})]
            self.assertFalse(s.finish());child.kill.assert_not_called();child.terminate.assert_not_called()
    def test_update_tail_after_observer_is_rejected(self):
        epoch=116444736000000000
        ident={'pid':17,'created100ns':str(epoch+100),'executable':r'C:\node.exe','exited100ns':'0','nativeMachine':34404,'processMachine':0}
        update=Mock();update.poll.return_value=0;update.returncode=0;update.pid=17
        session=Mock();session.result={'commands':[{'name':'published-driver-update','identity':ident,
            'terminalIdentity':dict(ident,exited100ns=str(epoch+400))}]}
        record=session.result['commands'][0]
        from run import held_handle_settlement
        record['settlement']=held_handle_settlement(ident,record['terminalIdentity'],17,0)
        session.children=[(update,record)]
        rows=[{'kind':'armed','utcNs':'5000'},{'kind':'settled','utcNs':'30000'}]
        with self.assertRaisesRegex(ValueError,'observation window'):
            complete_diagnostic(session,rows,update,ident)
        self.assertNotEqual(session.result.get('status'),'OBSERVATION_SETTLED')

    def test_window_accepts_contained_exit_and_rejects_missing_timing(self):
        epoch=116444736000000000
        ident={'pid':17,'created100ns':str(epoch+100),'executable':r'C:\node.exe','exited100ns':'0','nativeMachine':34404,'processMachine':0}
        update=Mock();update.poll.return_value=0;update.returncode=0;update.pid=17
        session=Mock();session.result={'commands':[{'name':'published-driver-update','identity':ident,
            'terminalIdentity':dict(ident,exited100ns=str(epoch+200))}]}
        record=session.result['commands'][0]
        from run import held_handle_settlement
        record['settlement']=held_handle_settlement(ident,record['terminalIdentity'],17,0)
        session.children=[(update,record)]
        rows=[{'kind':'armed','utcNs':'5000'},{'kind':'settled','utcNs':'30000'}]
        complete_diagnostic(session,rows,update,ident)
        self.assertTrue(session.result['observationWindow']['within'])
        self.assertEqual(session.result['status'],'OBSERVATION_SETTLED')
        session.result.pop('status')
        session.result['commands'][0]['terminalIdentity'].pop('exited100ns')
        with self.assertRaisesRegex(ValueError,'observation window'):
            complete_diagnostic(session,rows,update,ident)
        self.assertNotIn('status',session.result)

    def test_deadline_refuses_launch(self):
        with tempfile.TemporaryDirectory() as tmp:
            s=Session(Mock(),Path(tmp)/'evidence',0)
            with patch('run.subprocess.Popen') as popen:
                with self.assertRaises(ValueError): s.launch('update',['node.exe'],tmp)
                popen.assert_not_called()


if __name__=='__main__': unittest.main()
