/**
 * Preset close-reading session for "BERT" (arXiv 1810.04805, v2).
 * Chips quote the bundled page text verbatim so jump + highlight both work.
 */
import { cite } from "./cite.ts";

const md = String.raw;

export const bertPreset = {
  itemKey: "1810.04805",
  title: "BERT 精读：完形填空如何统一 NLP 预训练",
  conclusion: md`- **解决什么问题**：预训练目标一直是单向语言模型，这既限定了能用的架构，也让需要两侧上下文的 token 级任务做不好。${cite(1, "The major limitation is that standard language models are unidirectional, and this limits the choice of architectures that can be used during pre-training")}${cite(1, "where it is crucial to incorporate context from both directions")}
- **怎么做**：把「完形填空」当成预训练任务——每个序列随机遮住 15% 的 WordPiece，让模型双向把它们猜回来。${cite(4, "In all of our experiments, we mask 15% of all WordPiece tokens in each sequence at random")}
- **结果如何**：十一个 NLP 任务刷新最好成绩，GLUE 榜单 80.5 对 GPT 的 72.8，单个模型的 SQuAD 也超过以往的集成。${cite(1, "It obtains new state-of-the-art results on eleven natural language processing tasks")}${cite(6, "BERTLARGE obtains a score of 80.5, compared to OpenAI GPT, which obtains 72.8")}${cite(6, "our single BERT model outperforms the top ensemble system in terms of F1 score")}
- **为什么行得通**：一套架构跨任务复用，编码器用双向自注意力，把左右上下文在同一层里融进同一个表示。${cite(3, "A distinctive feature of BERT is its uniﬁed architecture across different tasks")}${cite(3, "the BERT Transformer uses bidirectional self-attention, while the GPT")}
- **代价与边界**：去掉 NSP 会让 QNLI / MNLI / SQuAD 明显掉点，微调在小数据集上还不稳，得多跑几次随机重启。${cite(8, "removing NSP hurts performance signiﬁcantly on QNLI, MNLI, and SQuAD")}${cite(6, "was sometimes unstable on small datasets, so we ran several random restarts")} 遮罩比例、统一输入表示与模型规模放在下面的方法拆解里。`,
  turns: [
    {
      q: "BERT 的核心创新点是什么？它相对 OpenAI GPT 的差别到底在哪一层？",
      a: md`## 一、问题：预训练目标把架构锁死了

在 BERT 之前有两条路：feature-based（ELMo）与 fine-tuning（GPT）。它们的共同点才是限制所在：${cite(1, "The two approaches share the same objective function during pre-training, where they use unidirectional language models to learn general language representations")}
作者的批评非常直接：${cite(1, "The major limitation is that standard language models are unidirectional, and this limits the choice of architectures that can be used during pre-training")}
对 token 级任务尤其致命——问答需要两侧上下文：${cite(1, "where it is crucial to incorporate context from both directions")}

## 二、核心创新（三件事）

**1）把预训练目标换成完形填空（MLM）**
${cite(2, "the representation to fuse the left and the right context")}
这样才允许「在**所有层**里同时条件于左右上下文」地预训练一个深度双向 Transformer：${cite(1, "BERT is designed to pretrain deep bidirectional representations from unlabeled text")}
> 一句总结：不是「预测下一个词」，而是「挖掉 15% 的词再预测它们」：${cite(4, "In all of our experiments, we mask 15% of all WordPiece tokens in each sequence at random")}

**2）加一个句间关系任务（NSP）**
${cite(4, "we pre-train for a binarized next sentence prediction task that can be trivially")}

**3）一套架构吃下所有下游任务**
${cite(3, "A distinctive feature of BERT is its uniﬁed architecture across different tasks")}
微调时只加一个输出层，其余参数全部继承预训练：${cite(2, "pre-trained representations reduce the need for many heavily-engineered task")}

## 三、与 GPT 的差别：只有一处，但代价是全局的

结构、层数、注意力实现几乎相同——差别只在**注意力掩码**：${cite(3, "the BERT Transformer uses bidirectional self-attention, while the GPT")}
BASE 规模还特意对齐 GPT 以保证可比性：${cite(3, "BERTBASE was chosen to have the same model size as OpenAI GPT for comparison purposes")}

## 四、规模与输入表示

| 模型 | $L$（层） | $H$（隐层） | $A$（头） | 参数量 |
| --- | --- | --- | --- | --- |
| BERTBASE | 12 | 768 | 12 | 110M |
| BERTLARGE | 24 | 1024 | 16 | 340M |

记号约定：${cite(3, "we denote the number of layers (i.e., Transformer blocks) as L, the hidden size as H, and the number of self-attention heads as A")}

输入侧的设计同样朴素但关键：单句与句对都用同一个 token 序列表达：${cite(4, "our input representation is able to unambiguously represent both a single sentence and a pair of sentences")}
每个 token 的输入 = token + segment + position 三种 embedding 相加：${cite(4, "its input representation is constructed by summing the corresponding token, segment, and position embeddings")}
词表与特殊符号：${cite(4, "We use WordPiece embeddings")}（30,000 词），序列首位固定放 [CLS]：${cite(4, "The ﬁrst token of every sequence is always a special classiﬁcation token")}

## 五、结果落点

${cite(1, "It obtains new state-of-the-art results on eleven natural language processing tasks")}（GLUE 80.5、MultiNLI 86.7、SQuAD v1.1 F1 93.2）。`,
    },
    {
      q: "把 MLM 的 80/10/10、NSP、以及 SQuAD 微调的打分公式逐步讲清楚，包括为什么要这样设计。",
      a: md`## 1. MLM：目标函数与设计动机

深度双向模型「理应」更强，但标准条件语言模型无法直接训练它——双向条件会让每个词间接「看到自己」，多层上下文里预测目标词就成了平凡任务：${cite(4, "bidirectional conditioning would allow each word to in")}

解法是**破坏输入而不是破坏目标**：随机掩蔽一部分 token，只预测被掩蔽的位置。
$$\mathcal{L}_{\mathrm{MLM}}=-\sum_{i\in\mathcal{M}}\log p\big(x_i\mid \tilde{x}_{1:n}\big),\qquad |\mathcal{M}|\approx 0.15\,n$$

被选中位置的替换策略是 80 / 10 / 10：${cite(4, "we replace the i-th token with")}
- 80%：换成 [MASK]
- 10%：换成随机 token
- 10%：保持原词

最后一种最容易忽略，它的作用是让模型在微调时不会因为「从没见过未被掩蔽的输入分布」而失配；整体目的写在 p.4：${cite(4, "a downside is that we are creating a mismatch between pre-training and")}
另一个与去噪自动编码器的区别也值得记住：${cite(4, "we only predict the masked words rather than")} —— 只预测掩蔽位，不重建整句，因此同样算力下能喂进更多「预测事件」。

## 2. NSP：把句间关系也变成自监督信号

$$\hat{y}=\mathrm{softmax}(W\,C),\qquad C\in\mathbb{R}^{H}\ \text{是 [CLS] 的最终隐向量}$$

采样方式是 50/50：${cite(4, "50% of the time B is the actual next sentence that follows A")}
一个必须记住的细节：$C$ 在未微调时并不是有意义的句向量，因为它是以 NSP 目标训练出来的：${cite(4, "The vector C is not a meaningful sentence representation without")}
消融显示 NSP 主要帮助需要「句对理解」的任务（QNLI/MNLI/SQuAD），见第 3 轮。

## 3. 与 Attention 那篇的公式对应

BERT 的编码器 = 去掉解码器的 Transformer，每层仍是「子层 + 残差 + 归一化」：
$$x\;\leftarrow\;\mathrm{LayerNorm}\big(x+\mathrm{MultiHead}(x)\big),\qquad \mathrm{FFN}(x)=\max(0,\,xW_1+b_1)W_2+b_2$$
唯一改动是注意力掩码：GPT 的因果掩码只在 $j\le i$ 处允许连接；BERT 全通。
> 所以三篇论文的关系可以这样记：Attention 给出「可并行的依赖建模原语」，ResNet 给出「让深度可训练的残差写法」，BERT 把两者组合成「可迁移的表示」。

## 4. SQuAD 微调：只引入两个向量

起止位置各自是一个 softmax 分布：
$$P_i=\frac{\exp(S\cdot T_i)}{\sum_j\exp(S\cdot T_j)}$$
候选片段 $(i,j)$（要求 $j\ge i$）的打分是两个向量的点积之和：
$$\mathrm{score}(i,j)=S\cdot T_i+E\cdot T_j$$

新增参数只有这两个向量：${cite(6, "We only introduce a start vector S")}
训练目标是起止位置对数似然之和：${cite(6, "The training objective is the sum of the log-likelihoods of the correct start and end positions")}

## 5. 微调配方（决定能否复现的部分）

GLUE：${cite(6, "We use a batch size of 32 and ﬁne-tune for 3 epochs over the data for all GLUE tasks")}
学习率按 Dev 集在网格里选：${cite(6, "we selected the best ﬁne-tuning learning rate")}
LARGE 在小数据集上会训不稳，需要随机重启挑最好的模型：${cite(6, "was sometimes unstable on small datasets, so we ran several random restarts")}
附录里给出的完整搜索范围：${cite(14, "Learning rate (Adam): 5e-5, 3e-5, 2e-5")}，epoch 数 2/3/4：${cite(14, "Number of epochs: 2, 3, 4")}
SQuAD 则固定 3 epoch、lr 5e-5、batch 32：${cite(6, "We fine-tune for 3 epochs with a learning rate of 5e-5 and a batch size of 32")}

## 6. 一个容易被跳过的输入技巧

问答把「问题 + 段落」打包成一条序列，问题用 A embedding、段落用 B embedding，仅靠 segment 区分：${cite(6, "the question using the A embedding and the passage using the B embedding")}
> 这正是「统一输入表示」的威力：不需要为 QA 设计新的编码结构，只需换输出层。`,
    },
    {
      q: "GLUE/SQuAD 的关键数字、消融结论，以及局限分别是什么？",
      a: md`## 1. GLUE（Table 1，p.6）

| 系统 | MNLI (m/mm) | QNLI | SST-2 | CoLA | 平均 |
| --- | --- | --- | --- | --- | --- |
| OpenAI GPT | 82.1/81.4 | 87.4 | 91.3 | 45.4 | 75.1 |
| BERTBASE | 84.6/83.4 | 90.5 | 93.5 | 52.1 | 79.6 |
| BERTLARGE | **86.7/85.9** | **92.7** | **94.9** | **60.5** | **82.1** |

${cite(6, "Both BERTBASE and BERTLARGE outperform all systems on all tasks by a substantial margin")}
官方榜单上的直接对比更能说明问题：${cite(6, "BERTLARGE obtains a score of 80.5, compared to OpenAI GPT, which obtains 72.8")}
注意一个诚实的细节：这里的「Average」排除了 WNLI，与官方 GLUE 口径略有差异（Table 1 说明）。

## 2. SQuAD v1.1（p.6–7）

Test F1 93.2（集成），单模型 91.8：超过以往榜单最好**集成**系统：${cite(6, "our single BERT model outperforms the top ensemble system in terms of F1 score")}
代价是数据侧做了一点增强——先在 TriviaQA 上微调再迁到 SQuAD：${cite(6, "use modest data augmentation in our system by first")}

## 3. 消融：真正的主贡献是双向 MLM

去掉 NSP：在 QNLI / MNLI / SQuAD 上明显下降：${cite(8, "removing NSP hurts performance signiﬁcantly on QNLI, MNLI, and SQuAD")}
把 MLM 换成单向 LTR（并去掉 NSP，与 GPT 可比）：所有任务都变差，MRPC 与 SQuAD 掉得最多：${cite(8, "The LTR model performs worse than the MLM model on all tasks")}
单向系统即使外加 BiLSTM 也追不上：${cite(8, "the results are still far worse than those of the pre")}
作者还正面论证了「双向 ≠ ELMo 式左右拼接」：${cite(8, "is strictly less powerful than a deep bidirectional model, since it can use both left and right context at every layer")}
模型大小的收益是单调的，连只有 3.6k 标注样本的 MRPC 也涨：${cite(8, "larger models lead to a strict")}
特征式用法同样有效（CoNLL-2003 NER 只加任务层）：${cite(9, "the feature-based approach, where fixed features are extracted from the")}

## 4. 局限（论文自陈 + 延伸讨论）

1. **监督信号稀疏 → 收敛更慢**：每个序列只有 15% 的位置产生预测，作者也承认这带来预训练/微调失配，因此需要 80/10/10 的补丁。
2. **NSP 的收益主要落在句对任务**：消融显示去掉它会伤 QNLI / MNLI / SQuAD（见上），但后续工作在更大规模语料与更长训练下发现这一目标的作用有限——这属于对本文的合理延伸，不是原文结论。
3. **[MASK] 失配仍然存在**：${cite(4, "since the [MASK] token does not ap")} —— 预训练看到的输入分布与微调不同，这是 MLM 范式的固有张力。
4. **推理与部署成本**：340M×24 层，加上「每个下游任务各自微调一份模型」的做法，在工程上是相当重的负担。
5. **延伸讨论**：掩蔽比例、预测事件数、静态 vs 动态掩蔽、以及把 MLM 换成更密集的噪声——这些是后续预训练工作反复修改的正是第 1 轮的这一个公式。

## 5. 如果只记三句话

1. 双向性来自**目标函数**，不是来自网络结构；
2. 统一输入表示 + 只换输出层，是「一个模型打通多任务」的两个必要条件；
3. 微调配方的重要性不低于架构——lr 网格、3 epoch、随机重启在论文里是被明确写进方法的部分。`,
    },
  ],
};
